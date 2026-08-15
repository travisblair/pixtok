# pixtok

A mobile-first, TikTok-style viewer for Pixiv. Browse Pixiv like a feed —
full-screen vertical cards, infinite scroll, one thumb for everything.
Built for phone screens and dogfooded on an iPhone through Tailscale.

**Pixtok is a single-user, self-hosted app.** One instance = one Pixiv
account = one set of preferences. The backend holds one Pixiv session
(refresh token, PHPSESSID, CSRF) as process-global state, and the
password gate is a shared secret, not a login system. It is not
designed to be shared between users, and two people logging into the
same instance would overwrite each other's Pixiv session. Deploy it for
yourself, reach it from your own devices — that's the intended model.


## Features

- **Home** — the personalized "For You" street feed, infinite scroll
- **Newest** — the live upload firehose (all / R18)
- **Illustrations** — Pixiv's top page (popular works)
- **Ranking** — daily / weekly / monthly / rookie / original / AI, male
  & female, with R18 variants
- **Discover** — the site-wide recommended feed
- **Search** — one box, no forced tag-vs-user choice: works results by
  default (Newest / Popular / Oldest ordering, All / R18), an Artists
  mode with per-user preview works, the tag's popular recommendations
  strip, and tappable related tags
- **Bookmarks** — your bookmarked works as a feed
- **Related stacks** — tap any work to drill into related works,
  up to 10 levels deep, with push animations and exact scroll restore
- **Artist libraries** — tap an artist's name for their full works
- **Like → recommendations** — liking a work loads Pixiv's own related
  recommendations in a modal
- **Ugoira** — animated works play on a canvas with tap-to-play
- **Blocked tags** — hide works by tag (client-side, no premium needed)
- **Data saver** — 540px images instead of full resolution
- **Session persistence** — reload (even an iOS jetsam kill) restores
  the feed, scroll position, open stacks and search exactly where you
  left off
- **Password gate** — one password in front of everything when the app
  is exposed publicly

## Setup

### 1. Pixiv authentication

pixtok talks to Pixiv's own APIs, so it needs your account session:

```
cp .env.example .env
```

Fill in:

| Variable | What it is |
|---|---|
| `PIXIV_REFRESH_TOKEN` | OAuth refresh token for the app API (rankings, discover, bookmarks, likes, related works) |
| `PIXIV_PHPSESSID` | Web session cookie for the personalized feeds (Home street, Newest, Illustrations, Search) |

Sign in inside the app once (Account → Sign in) and pixtok captures and
stores both automatically — no manual token wrangling.

**Note for clones:** the like button and bookmarks are real actions on
your Pixiv account. If you only want read-only browsing, you can skip
them — everything else works the same.

**Credential storage:** pixiv credentials (the refresh token, PHPSESSID,
and CSRF token) are written as plaintext to `.env` (mode 0600). The
refresh token is PERMANENT — pixiv never rotates it — so file read
access is full account control. Keep the file on a machine you trust
and don't commit it (`.env` is gitignored). The `.env` is resolved next
to the backend binary (or `backend/../.env` in the dev layout), not the
current working directory.

### 2. Password gate (optional but recommended for public URLs)

If the app is reachable from the public internet (Tailscale Funnel,
ngrok, a VPS), set a gate password:

```
PIXTOK_GATE_PASSWORD_HASH=your-bcrypt-hash-here
PIXTOK_PUBLIC_HTTPS=true   # HTTPS deployment → Secure cookies
```

Generate the hash with `htpasswd -nbB user password` (cut at the second
colon) or any bcrypt tool. Plaintext passwords are rejected at boot
unless `PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true` is set (local dev
only — the hash lives in memory, so the cookie resets every restart).
Without a password the gate is disabled and the app is open to whoever
can reach the URL. Set `PIXTOK_PUBLIC_HTTPS=true` when the app is
served over HTTPS (Tailscale Funnel) so the gate cookie and the login
proxy's rewritten pixiv cookies keep `Secure`.

### 3. Run

```
cd backend && go run .
cd frontend && npm install && npm run dev
```

- Backend: `127.0.0.1:8080` (loopback only — the frontend dev proxy
  injects a shared API key)
- Frontend: Vite dev server on `:5173`; set `VITE_ALLOWED_HOSTS` in
  `.env` to expose it on a tailnet/funnel

## Tech

- **Backend:** Go — proxies the Pixiv app API and web AJAX endpoints,
  token rotation, image CDN proxy with in-memory caching, SQLite prefs
  (blocked tags, image quality), password gate
- **Frontend:** SolidJS + Vite — scroll-snap feed, IntersectionObserver
  lazy loading/unloading, canvas ugoira playback, localStorage session
  snapshots
