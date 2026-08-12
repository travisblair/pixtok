import { For } from "solid-js";

/**
 * All | R18 content pills — shared by the Ranking (top row), Newest, and
 * Illustrations (top page) feeds.
 */
export default function ContentPills(props: {
  content: string; // "all" | "r18"
  onChange: (content: string) => void;
}) {
  const modes = [
    { value: "all", label: "All" },
    { value: "r18", label: "R18" },
  ];

  return (
    <div class="content-pills">
      <For each={modes}>
        {(m) => (
          <button
            type="button"
            class={m.value === props.content ? "mode-pill active" : "mode-pill"}
            onClick={() => props.onChange(m.value)}
          >
            {m.label}
          </button>
        )}
      </For>
    </div>
  );
}
