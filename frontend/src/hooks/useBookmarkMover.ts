import { createSignal, onCleanup } from "solid-js";
import { like as likeWork, unlike as unlikeWork } from "../api/illust";
import { ApiError, reportApiError } from "../api/client";

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
 * The queue is strictly serial and paced: each work's two calls fire
 * back-to-back (unlike → like — a move is one logical operation, and a
 * pair of calls on the same work reads as a single move upstream), then
 * the throttle gap lands BETWEEN works (default 1600ms). No retries
 * (house rule — retrying rate-limited endpoints draws attention).
 *
 * Failure policy: an upstream 404 means the WORK ITSELF is gone
 * (deleted/removed) — the bookmark died with it, so the work is SKIPPED
 * and the queue continues (counted in `skipped`; there is nothing to
 * restore or re-add). Every OTHER failure (429/5xx/network) stops the
 * queue — plowing through a rate-limit window is exactly the attention
 * this queue exists to avoid. A work whose delete succeeded but re-add
 * failed is the LOSS WINDOW: it is reported as kind "add" so the UI can
 * say "bookmark removed, re-add manually".
 */

export const DEFAULT_MOVE_PACE_MS = 1600;

export type MoveFailureKind = "delete" | "add" | "cancelled";

export interface MoveFailure {
  id: number;
  kind: MoveFailureKind;
}

export interface MoveResult {
  moved: number;
  /** Works the queue skipped because they are GONE upstream (404 on
   *  like/unlike) — nothing to restore, nothing to re-add. */
  skipped: number;
  failures: MoveFailure[];
  /** True when the queue stopped early (cancel or failure) — the rest
   *  of the requested works are in `failures` as kind "cancelled". */
  cancelled: boolean;
}

export interface BookmarkMoverOptions {
  /** Milliseconds BETWEEN works (the unlike→like pair fires
   *  back-to-back). Tests pass ~50; production uses
   *  DEFAULT_MOVE_PACE_MS. */
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

  /** An upstream 404 on like/unlike = the work is GONE (deleted or
   *  removed). Skip it and keep going — there is nothing to restore. */
  function isGoneWork(err: unknown): boolean {
    return err instanceof ApiError && err.kind === "http" && err.status === 404;
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
    let skipped = 0;
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
        if (isGoneWork(err)) {
          // The work is gone upstream: nothing to delete, nothing to
          // re-add. Skip it (no like attempt — the work is dead) and
          // keep the queue moving.
          skipped++;
          setProgress({ done: moved + skipped, total: targets.length });
          continue;
        }
        reportApiError(err);
        failures.push({ id, kind: "delete" });
        stopped = true;
        markCancelled(i + 1);
        break;
      }

      // No wait here: the delete+add pair is one move. The throttle gap
      // lives BETWEEN works (below) — strictly one upstream request in
      // flight at all times either way.
      try {
        await likeWork(id);
      } catch (err) {
        if (isGoneWork(err)) {
          // Delete succeeded but the work is gone upstream (404 on
          // add): its bookmark died with the work. Skip and continue —
          // this is NOT the loss window (nothing to restore).
          skipped++;
          setProgress({ done: moved + skipped, total: targets.length });
          continue;
        }
        reportApiError(err);
        // Delete succeeded, re-add failed: the LOSS WINDOW.
        failures.push({ id, kind: "add" });
        stopped = true;
        markCancelled(i + 1);
        break;
      }

      moved++;
      setProgress({ done: moved + skipped, total: targets.length });

      // Pace before the next work's first upstream call.
      if (i < targets.length - 1) await wait(paceMs);
    }

    setRunning(false);
    abort = null;
    setSelectedIds(new Set<number>());
    setSelectionMode(false);
    const result: MoveResult = { moved, skipped, failures, cancelled: stopped };
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
