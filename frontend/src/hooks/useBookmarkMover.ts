import { createSignal, onCleanup } from "solid-js";
import { like as likeWork, unlike as unlikeWork } from "../api/illust";
import { reportApiError } from "../api/client";

/**
 * Move public bookmarks to the private pile.
 *
 * Pixiv has no reliable "reclassify in place": BookmarkAdd v2 with a
 * different restrict does NOT cleanly move a work (live probe), so each
 * work is an explicit BookmarkDelete v1 → BookmarkAdd v2 pair. Both
 * calls are the EXISTING /api/illust/:id/{unlike,like} routes — the
 * queue calls them directly, never through a card's toggleLike, so the
 * bookmarks tab's unlike-removes-the-card handler can't fire.
 *
 * The queue is strictly serial and paced: default 1600ms between
 * upstream calls (unlike → wait → like → wait → next work). Any
 * non-200 stops the whole queue; no retries (house rule — retrying
 * rate-limited endpoints draws attention). A work whose delete
 * succeeded but re-add failed is the LOSS WINDOW: it is reported as
 * kind "add" so the UI can say "bookmark removed, re-add manually".
 */

export const DEFAULT_MOVE_PACE_MS = 1600;

export type MoveFailureKind = "delete" | "add" | "cancelled";

export interface MoveFailure {
  id: number;
  kind: MoveFailureKind;
}

export interface MoveResult {
  moved: number;
  failures: MoveFailure[];
  /** True when the queue stopped early (cancel or failure) — the rest
   *  of the requested works are in `failures` as kind "cancelled". */
  cancelled: boolean;
}

export interface BookmarkMoverOptions {
  /** Milliseconds between upstream calls. Tests pass ~50; production
   *  uses DEFAULT_MOVE_PACE_MS. */
  paceMs?: number;
  /** Always fired when a run finishes (success, failure or cancel). */
  onDone?: (result: MoveResult) => void;
  /** Fired only when the run stopped early (cancel or failure) —
   *  before onDone. */
  onCancel?: (result: MoveResult) => void;
}

export function useBookmarkMover(options: BookmarkMoverOptions = {}) {
  const paceMs = options.paceMs ?? DEFAULT_MOVE_PACE_MS;
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<Set<number>>(new Set<number>());
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal({ done: 0, total: 0 });
  let abort: AbortController | null = null;

  const selectedCount = () => selectedIds().size;

  function enterSelection() {
    if (running()) return;
    setSelectionMode(true);
  }

  function exitSelection() {
    if (running()) return; // a run owns the selection until it finishes
    setSelectionMode(false);
    setSelectedIds(new Set<number>());
  }

  /** Abort the queue at the next work boundary and clear selection UI.
   *  The in-flight work always completes (cancel never lands between a
   *  work's delete and its re-add — that would create a loss window). */
  function reset() {
    abort?.abort();
    if (!running()) {
      setSelectionMode(false);
      setSelectedIds(new Set<number>());
    }
  }

  function toggle(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select all CURRENTLY LOADED works (the illusts() array). */
  function selectAll(ids: number[]) {
    setSelectedIds(new Set(ids));
  }

  function deselectAll() {
    setSelectedIds(new Set<number>());
  }

  function wait(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function run(ids: number[]) {
    if (running()) return;
    const targets = [...ids];
    if (targets.length === 0) return;

    const controller = new AbortController();
    abort = controller;
    setRunning(true);
    setProgress({ done: 0, total: targets.length });

    const failures: MoveFailure[] = [];
    let moved = 0;
    let stopped = false;

    // Record every not-attempted work after a stop/failure so the report
    // accounts for the whole requested batch.
    function markCancelled(from: number) {
      for (let j = from; j < targets.length; j++) {
        failures.push({ id: targets[j], kind: "cancelled" });
      }
    }

    for (let i = 0; i < targets.length; i++) {
      // Cancel is only honoured at a WORK BOUNDARY: the in-flight work
      // (delete + re-add) always completes.
      if (controller.signal.aborted) {
        stopped = true;
        markCancelled(i);
        break;
      }
      const id = targets[i];

      try {
        await unlikeWork(id);
      } catch (err) {
        reportApiError(err);
        failures.push({ id, kind: "delete" });
        stopped = true;
        markCancelled(i + 1);
        break;
      }

      // Pace between the two upstream calls of the SAME work too — the
      // probe's shape is unlike → wait → like.
      await wait(paceMs);

      try {
        await likeWork(id);
      } catch (err) {
        reportApiError(err);
        // Delete succeeded, re-add failed: the LOSS WINDOW.
        failures.push({ id, kind: "add" });
        stopped = true;
        markCancelled(i + 1);
        break;
      }

      moved++;
      setProgress({ done: moved, total: targets.length });

      // Pace before the next work's first upstream call.
      if (i < targets.length - 1) await wait(paceMs);
    }

    setRunning(false);
    abort = null;
    setSelectedIds(new Set<number>());
    setSelectionMode(false);
    const result: MoveResult = { moved, failures, cancelled: stopped };
    if (stopped) options.onCancel?.(result);
    options.onDone?.(result);
  }

  function cancel() {
    abort?.abort();
  }

  // Unmount (or App teardown) aborts at the boundary; the loop's finally
  // path still clears running state if it gets to run.
  onCleanup(() => abort?.abort());

  return {
    paceMs,
    selectionMode,
    selectedIds,
    selectedCount,
    running,
    progress,
    enterSelection,
    exitSelection,
    reset,
    toggle,
    selectAll,
    deselectAll,
    run,
    cancel,
  };
}
