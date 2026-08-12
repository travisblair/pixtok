import type { JSX } from "solid-js";

/**
 * Shared modal scaffolding (freezer-app convention): div-based overlay,
 * 60% black backdrop, click-outside dismiss, article body, chrome-less ✕
 * top-left in the header, 8px-gap button row in the footer. Every modal
 * in the app builds on this — no copy-pasted overlay/dialog wrappers.
 */
export default function BaseModal(props: {
  title: string;
  closeLabel: string; // aria-label for the ✕, e.g. "Close settings"
  onClose: () => void;
  children?: JSX.Element;
  footer?: JSX.Element;
}) {
  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <article>
          <header class="modal-header">
            <strong>{props.title}</strong>
            <button
              type="button"
              class="modal-x"
              onClick={props.onClose}
              aria-label={props.closeLabel}
            >
              ✕
            </button>
          </header>

          {props.children}

          {props.footer && <footer class="modal-footer">{props.footer}</footer>}
        </article>
      </div>
    </div>
  );
}
