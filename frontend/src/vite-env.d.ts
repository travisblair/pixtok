/// <reference types="vite/client" />

// Build-time git short hash, injected by vite.config.ts (define). Shown
// in the Settings modal so a device's bundle version is identifiable at
// a glance — "unknown" means the build ran outside a git checkout.
declare const __BUILD_STAMP__: string;
