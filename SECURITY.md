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
   host-only (Domain=/Secure=/Expires=/Max-Age=/SameSite stripped).
4. **Only POST mutates account state.** Bookmark/like mutations are
   POST-only and the proxy allows only GET/POST/HEAD.
5. **Credentials never touch Git or logs.** `.env` is gitignored; the
   request logger records method + path only, never query strings or
   bodies. If you ever find a credential in a log line or a commit,
   that's a bug.
6. **Every URL, ID, cursor, and upstream body is untrusted** — even when
   it came from Pixiv. Validate at the server boundary (the image proxy
   re-validates the CDN host on every request; pagination URLs are
   re-validated before fetch).

## Threat model (summary)

| Attacker | Surface | Mitigation |
| --- | --- | --- |
| Internet attacker at the public URL | Gate password, login proxy | bcrypt + HMAC gate cookie (HttpOnly, SameSite=Lax, Secure on HTTPS), bounded concurrent attempts, progressive failure delay |
| LAN attacker | Backend port, Vite dev server | API-key gate, loopback-only backend, Host allowlist in Vite |
| Malicious webpage in the user's browser | CSRF against mutations | POST-only mutations, SameSite=Lax, JSON content-type enforcement on the gate |
| Malicious Pixiv content (titles, tags, URLs) | XSS, open proxy abuse | No raw-HTML rendering in the frontend; server-side host allowlists |
| Attacker with browser profile access | localStorage snapshots | Documented; persistence is a convenience layer, not an auth boundary |
| Attacker with server filesystem access | `.env` credentials | Plaintext `.env` is an accepted risk for this self-hosted model — keep the file `chmod 600` (the backend warns at boot if it isn't) |

## Operational notes

- **Plaintext gate passwords fail closed.** `PIXTOK_GATE_PASSWORD_HASH`
  must be a bcrypt hash. A plaintext value only works when
  `PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true` is set explicitly (local
  dev only — the in-memory hash does not survive restarts).
- **Config precedence:** environment variables win over `.env`. After an
  in-app login persists fresh tokens to `.env`, an env var set in the
  process environment keeps shadowing them on the next boot.
- **Vite dev server** is a development server; for public exposure,
  prefer serving a production build behind a hardened reverse proxy.
- **The image proxy** accepts only Pixiv CDN hosts, HTTPS, and an
  allowlisted set of content types (`image/*`, `application/zip` for
  ugoira archives — SVG is rejected).
