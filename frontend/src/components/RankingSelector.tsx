import { For } from "solid-js";
import type { ContentMode, RankingMode } from "../types";

/**
 * Ranking mode pills (the second header row): the ranking lists —
 * Daily/Weekly/Monthly/Rookie/Original/AI/Male/Female, swapped to the
 * adult variants when content=r18. Horizontally scrollable.
 *
 * Values are the app-API /v1/illust/ranking mode strings. The All/R18
 * content pills live on the burger row (ContentPills, rendered by App).
 */
const ALL_MODES: { value: RankingMode; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "week_rookie", label: "Rookie" },
  { value: "week_original", label: "Original" },
  { value: "day_ai", label: "AI" },
  { value: "day_male", label: "Male" },
  { value: "day_female", label: "Female" },
];

const R18_MODES: { value: RankingMode; label: string }[] = [
  { value: "day_r18", label: "Daily" },
  { value: "week_r18", label: "Weekly" },
  { value: "day_male_r18", label: "Male" },
  { value: "day_female_r18", label: "Female" },
];

export default function RankingSelector(props: {
  content: ContentMode; // picks the mode set
  mode: RankingMode;
  onChange: (mode: RankingMode) => void;
}) {
  const modes = () => (props.content === "r18" ? R18_MODES : ALL_MODES);

  return (
    <div class="mode-selector no-scrollbar fade-edges">
      <For each={modes()}>
        {(m) => (
          <button
            type="button"
            class={m.value === props.mode ? "mode-pill active" : "mode-pill"}
            onClick={() => props.onChange(m.value)}
          >
            {m.label}
          </button>
        )}
      </For>
    </div>
  );
}
