# Security

Pixtok is a single-user, self-hosted Pixiv viewer. One instance = one
Pixiv account = one set of preferences. The password gate is an
application password, **not** multi-user authentication: anyone who
knows the gate password gets full access to the owner's Pixiv account
(bookmarks, likes, session-backed feeds, the login proxy). Do not hand
the URL + password to people you don't trust with the account itself.

## Security invariants

These rules are load-bearing. Do not weaken them.

1. **Bearer token / session confinement.** The server never sends the
   Pixiv bearer token or PHPSESSID to any host other than an explicitly
   allowlisted Pixiv endpoint (`app-api.pixiv.net`, `www.pixiv.net`,
   `accounts.pixiv.net`, `oauth.secure.pixiv.net`, `i.pximg.net`).
2. **Exact-host matching, never prefixes.** URL allowlists and the login
   proxy's redirect/body rewrites compare parsed scheme + hostname +
   port. Prefix matching would admit suffix-domain lookalikes
   (`accounts.pixiv.net.evil.example`) — see `authproxy_security_test.go`.
3. **The browser never leaves our origin during login.** Upstream
   redirects are rewritten onto `/api/auth/px/*`; cookies are rewritten
   host-only (Domain/Expires/Max-Age/SameSite stripped; `Secure` is
   preserved per-request — kept on HTTPS transports, dropped on HTTP so
   plaintext-tailnet sessions don't silently break).
4. **Only POST mutates account state.** Bookmark/like mutations are
   POST-only and the proxy allows only GET/POST/HEAD.
5. **Credentials never touch Git, logs, or the frontend state.**
   `.env` is gitignored; the request logger records method + path only,
   never query strings or bodies (auth-endpoint errors log status only);
   the localStorage snapshot holds navigation/layer state, never
   credentials. If you ever find a credential in a log line, a commit,
   or the snapshot, that's a bug.
6. **Every URL, ID, cursor, and upstream body is untrusted** — even when
   it came from Pixiv. Validate at the server boundary (the image proxy
   re-validates the CDN host on every request; pagination URLs are
   re-validated before fetch).
7. **Credential persistence is transactional.** A rotated refresh token
   is written to `.env` BEFORE it replaces the in-memory value; login
   reports success only after persistence succeeds. Memory never gets
   ahead of disk — a restart always resumes the durable credential.

## Threat model (summary)

| Attacker | Surface | Mitigation |
| --- | --- | --- |
| Internet attacker at the public URL | Gate password, login proxy | bcrypt + HMAC gate cookie (HttpOnly, SameSite=Lax, Secure on HTTPS), bounded concurrent attempts, progressive failure delay with 10-min decay |
| Internet attacker, sustained | Availability (RAM/CPU) | Two-tier rate limiter (per-source buckets + global ceiling; X-Forwarded-For trusted only from loopback proxies), image-fetch semaphore (8 concurrent, 429 beyond), bounded image cache |
| LAN attacker | Backend port, Vite dev server | API-key gate, loopback-only backend, Host allowlist in Vite |
| Malicious webpage in the user's browser | CSRF against mutations | POST-only mutations, SameSite=Lax, JSON content-type enforcement on the gate |
| Malicious Pixiv content (titles, tags, URLs) | XSS, open proxy abuse | No raw-HTML rendering in the frontend; server-side host allowlists |
| Attacker with browser profile access | localStorage snapshots | Documented; persistence is a convenience layer, not an auth boundary |
| Attacker with server filesystem access | `.env` credentials | Plaintext `.env` is an accepted risk for this self-hosted model — keep the file `chmod 600`. The backend warns at boot if group/world-readable and REFUSES to boot if group/world-writable |

## Operational notes

- **Plaintext gate passwords fail closed.** `PIXTOK_GATE_PASSWORD_HASH`
  must be a bcrypt hash. A plaintext value only works when
  `PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true` is set explicitly (local
  dev only). On first boot the plaintext is hashed and the bcrypt hash
  persisted into `.env`, so sessions survive restarts.
- **No logout.** The gate cookie is a 30-day bearer token derived from
  the password hash. There is no server-side session store, so there is
  no revocation short of changing the password (which invalidates every
  cookie at once). A stolen cookie = access until expiry or a password
  change. Documented tradeoff; accepted for the single-user model.
- **Config precedence / credential ownership:** environment variables
  win over `.env` (bootstrap config). When credentials are supplied via
  the environment, they are externally managed — the app's own
  persistence (login capture, token rotation) writes to `.env` and will
  be shadowed by the env vars on the next boot. Pick ONE model per
  deployment. `PIXTOK_ENV_FILE=/path/to/.env` pins one file explicitly
  and disables the candidate search.
- **Token rotation is persisted.** Pixiv can return a fresh refresh
  token on any refresh; it is written to `.env` before being committed
  to memory. If the write fails the refresh fails (and the running
  process keeps the old pair) rather than risking a restart that
  resurrects a stale token.
- **Rate limiting is two-tier.** Each client source gets private
  per-minute buckets; a process-wide ceiling bounds the aggregate. The
  client source comes from `X-Forwarded-For` ONLY when the request
  arrives from a loopback peer (Vite/serve/Funnel) — direct clients are
  keyed by their remote address, and their forged XFF is ignored.
- **Image fetches are concurrency-bounded** (8 in flight; saturated
  requests get 429 + Retry-After) and bodies over the 5 MB cache
  ceiling stream without being fully buffered.
- **CI: deliberately omitted.** The suite (`go test -race`, vitest,
  Playwright e2e, embedded-frontend build) requires the local dev stack —
  `.env`, the embedded static build, a real gate unlock — which CI can
  only approximate, and a CI copy would pass while production breaks
  (every production incident to date was caught by the local suite or
  the live device, not a sandbox). The gate is the full local suite
  before every push; `govulncheck` and `npm audit` are run manually each
  review cycle.
- **Vite dev server** is a development server; for public exposure,
  serve the production single binary (embedded frontend) behind the
  tailnet — see README.
- **The image proxy** accepts only Pixiv CDN hosts, HTTPS, and an
  allowlisted set of content types (JPEG/PNG/GIF/WebP/AVIF,
  `application/zip` for ugoira archives — SVG is rejected).
