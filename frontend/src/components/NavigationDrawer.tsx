import { createSignal, For, Show } from "solid-js";

type FeedType = "home" | "newest" | "illustrations" | "top" | "recommended" | "bookmarks";

const NAV_ITEMS: { value: FeedType; label: string }[] = [
  { value: "home", label: "Home" },
  // new_illust.php — the newest-upload firehose.
  { value: "newest", label: "Newest" },
  // /illustration — pixiv's top page (popular works, mode all|r18).
  { value: "top", label: "Illustrations" },
  // value stays "illustrations" internally — the label names what the
  // feed IS: pixiv's ranking (app-API /v1/illust/ranking), not the
  // site's /illustration top page.
  { value: "illustrations", label: "Ranking" },
  { value: "recommended", label: "Discover" },
  { value: "bookmarks", label: "Bookmarks" },
];

export default function NavigationDrawer(props: {
  feedType: FeedType;
  onChange: (type: FeedType) => void;
  onSearch?: () => void;
  onSettings?: () => void;
  onLogin?: () => void;
}) {
  const [open, setOpen] = createSignal(false);

  function select(type: FeedType) {
    props.onChange(type);
    setOpen(false);
  }

  return (
    <>
      {/* Burger pill */}
      <button
        type="button"
        class="mode-pill burger-pill"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
      >
        ☰
      </button>

      {/* Backdrop */}
      <Show when={open()}>
        <div class="drawer-backdrop" onClick={() => setOpen(false)} />
      </Show>

      {/* Drawer */}
      <div class={open() ? "drawer open" : "drawer"}>
        <div class="drawer-header">
          <span class="drawer-title">Navigation</span>
          <button
            type="button"
            class="drawer-close"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            ✕
          </button>
        </div>
        <nav class="drawer-nav">
          <Show when={props.onSearch}>
            <button
              type="button"
              class="drawer-item"
              onClick={() => {
                props.onSearch?.();
                setOpen(false);
              }}
            >
              🔍 Search
            </button>
            <div class="drawer-divider" />
          </Show>

          <For each={NAV_ITEMS}>
            {(item) => (
              <button
                type="button"
                class={
                  item.value === props.feedType
                    ? "drawer-item active"
                    : "drawer-item"
                }
                onClick={() => select(item.value)}
              >
                {item.label}
              </button>
            )}
          </For>

          {/* Account + Settings live here, not in the header */}
          <Show when={props.onLogin}>
            <div class="drawer-divider" />
            <button
              type="button"
              class="drawer-item"
              onClick={() => {
                props.onLogin?.();
                setOpen(false);
              }}
            >
              👤 Account
            </button>
          </Show>
          <Show when={props.onSettings}>
            <button
              type="button"
              class="drawer-item"
              onClick={() => {
                props.onSettings?.();
                setOpen(false);
              }}
            >
              ⚙ Settings
            </button>
          </Show>
        </nav>
      </div>
    </>
  );
}
