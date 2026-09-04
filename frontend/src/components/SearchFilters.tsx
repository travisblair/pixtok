import { For, Show } from "solid-js";
import BaseModal from "./BaseModal";

export interface SearchFilterValues {
  order: string; // date_d | date
  contentMode: "all" | "safe" | "r18";
  workType: "all" | "illust" | "ugoira";
  sMode: string; // s_tag | s_tag_full | s_tc
  aiType: "0" | "1";
  dateMode: "all" | "custom"; // custom reveals the date inputs
  scd: string; // posting-date bounds (YYYY-MM-DD, "" = unbounded)
  sce: string;
}

export const DEFAULT_FILTERS: SearchFilterValues = {
  order: "date_d",
  contentMode: "all",
  workType: "all",
  sMode: "s_tag_full",
  aiType: "0",
  dateMode: "all",
  scd: "",
  sce: "",
};

/** Accessors over the live filter state (read reactively inside the modal). */
export type SearchFilterGetters = {
  [K in keyof SearchFilterValues]: () => SearchFilterValues[K];
};

/** Number of filters currently off their defaults — the Filters badge. */
export function activeFilterCount(v: SearchFilterValues): number {
  let count = 0;
  if (v.order !== DEFAULT_FILTERS.order) count++;
  if (v.contentMode !== DEFAULT_FILTERS.contentMode) count++;
  if (v.workType !== DEFAULT_FILTERS.workType) count++;
  if (v.sMode !== DEFAULT_FILTERS.sMode) count++;
  if (v.aiType !== DEFAULT_FILTERS.aiType) count++;
  if (v.dateMode !== "all" || v.scd || v.sce) count++;
  return count;
}

function Pills<T extends string>(props: {
  options: { value: T; label: string }[];
  current: () => T;
  onPick: (v: T) => void;
}) {
  return (
    <div class="filter-pills">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            class={props.current() === o.value ? "mode-pill active" : "mode-pill"}
            onClick={() => props.onPick(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

function Section(props: { label: string; children?: any }) {
  return (
    <div class="filter-section">
      <div class="filter-label">{props.label}</div>
      {props.children}
    </div>
  );
}

/**
 * The search filter sheet — every verified pixiv search option pixtok
 * supports. Each pick applies immediately (re-runs the current query);
 * the posting-date range reveals two native date inputs when Custom is
 * active. Reset returns everything to the site's defaults.
 *
 * Values arrive as ACCESSORS, not a snapshot: the parent passes its
 * signal getters so each binding here tracks live state itself. (A
 * plain values object froze the modal at open time — the parent's
 * conditional render didn't re-run this subtree on filter changes.)
 */
export default function SearchFilters(props: {
  values: SearchFilterGetters;
  onPick: (patch: Partial<SearchFilterValues>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const values = props.values;
  const pick = props.onPick;

  return (
    <BaseModal
      title="Filters"
      closeLabel="Close filters"
      onClose={props.onClose}
      footer={
        <button
          type="button"
          class="mode-pill"
          onClick={() => {
            props.onReset();
          }}
        >
          Reset
        </button>
      }
    >
      <Section label="Sort">
        <Pills
          options={[
            { value: "date_d", label: "Newest" },
            { value: "date", label: "Oldest" },
          ]}
          current={values.order}
          onPick={(order) => pick({ order })}
        />
      </Section>

      <Section label="Content">
        <Pills
          options={[
            { value: "all", label: "All" },
            { value: "safe", label: "All ages" },
            { value: "r18", label: "R18" },
          ]}
          current={values.contentMode}
          onPick={(contentMode) => pick({ contentMode })}
        />
      </Section>

      <Section label="Work type">
        <Pills
          options={[
            { value: "all", label: "All works" },
            { value: "illust", label: "Illustrations only" },
            { value: "ugoira", label: "Ugoira only" },
          ]}
          current={values.workType}
          onPick={(workType) => pick({ workType })}
        />
      </Section>

      <Section label="Match">
        <Pills
          options={[
            { value: "s_tag", label: "Tags (partial)" },
            { value: "s_tag_full", label: "Tags (exact)" },
            { value: "s_tc", label: "Title & caption" },
          ]}
          current={values.sMode}
          onPick={(sMode) => pick({ sMode })}
        />
      </Section>

      <Section label="AI-generated">
        <Pills
          options={[
            { value: "0", label: "Display" },
            { value: "1", label: "Hide" },
          ]}
          current={values.aiType}
          onPick={(aiType) => pick({ aiType })}
        />
      </Section>

      <Section label="Posting date">
        <Pills
          options={[
            { value: "all", label: "All periods" },
            { value: "custom", label: "Custom" },
          ]}
          current={values.dateMode}
          onPick={(sel) => {
            if (sel === "all") pick({ dateMode: "all", scd: "", sce: "" });
            else pick({ dateMode: "custom" });
          }}
        />
        <Show when={values.dateMode() === "custom"}>
          <div class="filter-dates">
            <input
              type="date"
              class="filter-date-input"
              value={values.scd()}
              aria-label="From date"
              onInput={(e) => pick({ scd: (e.currentTarget as HTMLInputElement).value })}
            />
            <span class="filter-date-sep">to</span>
            <input
              type="date"
              class="filter-date-input"
              value={values.sce()}
              aria-label="To date"
              onInput={(e) => pick({ sce: (e.currentTarget as HTMLInputElement).value })}
            />
          </div>
        </Show>
      </Section>
    </BaseModal>
  );
}
