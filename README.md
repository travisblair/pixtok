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

Everything opens from the ☰ drawer. Feeds scroll vertically with
infinite scroll; in the default strip view each card is a full-screen
page.

### Feeds

- **Home** — your personalized "For You" street feed.
- **Newest** — the live upload firehose; the All / R18 pills above the
  feed switch content.
- **Illustrations** — Pixiv's top page (popular works).
- **Ranking** — daily / weekly / monthly / rookie / original / AI
  rankings, male & female, with R18 variants; pick content and mode with
  the pills above the feed.
- **Discover** — the site-wide recommended feed.
- **Bookmarks** — everything you've bookmarked on Pixiv, as a feed.

### View modes

Feeds and artist pages render as a full-screen strip (default) or a
compact square-thumbnail grid — Settings → View toggles them
independently. Stacks and the recommendations modal always stay strip.
Grid cells are deliberately minimal (image, heart, ugoira badge); the
strip carries the text overlays. Grid cells load square_medium thumbs
and skip the scroll-based unload window — cheap to keep in memory.

### Search

☰ → Search, type a term, hit Search. Works results by default.

- **Filters** — sort (Newest / Popular / Oldest), content (All / All
  ages / R18), work type (All works / Illustrations only / **Ugoira
  only**), match mode (tags partial / tags exact / title & caption),
  AI-generated (display / hide), and a posting-date range.
- **Artists** — the Artists pill switches to people search; each row
  shows three preview works.
- **Popular & related tags** — page 1 of works results carries the
  tag's popular-works strip and tappable related-tag pills.

### Related stacks

Tap on any image card to open it in a "stack": the work is on top with its
related works loading beneath it. Scroll for more, or tap another work
inside the stack to drill deeper (up to 10 levels — the "N/10" badge
shows the depth). ← Back returns one level; ✕ closes the whole stack
back to the feed. Each level remembers its scroll position.

### Artist pages

Tap an artist's name on any card — or an artist row in Search →
Artists — to open their library. Scroll for more works; tap any work to
open a stack on top of the artist page.

### Recommendations (the like modal)

Tap the ♡ on any card: the work is bookmarked on Pixiv and a
"Recommendations for ⟨title⟩" modal opens with Pixiv's own related
works. The heart stays synced with your Pixiv bookmarks across the
whole app.

### Ugoira (animated works)

Cards with a small ▶ button above the title are animations. Tap ▶ to
play, tap again to pause — a spinner shows while the frames download.
The loop runs on a canvas (no video element) and frees its frames when
you scroll away. Tapping the image itself opens the related stack like
any other card.

### Tags

Every card shows its tags, with Pixiv's English translation beneath the
original where one exists. Tap a tag chip to open that tag's page (a
search seeded with the tag). Tap the ⚙️ button under the ♡ to open the
work's tag list — tapping a tag there blocks or unblocks it. Blocked
tags hide matching works from everything loaded afterwards; manage the
list any time in Settings.

### Settings

☰ → Settings: image quality (**Full** or **Data saver** — 540px images
for cellular), feed and artist view modes (**Strip** or **Grid**), and
your blocked-tags list.

### Session persistence

Reload — or an iOS jetsam kill and reopen — lands you exactly where you
left off: same feed, scroll position, open stacks, search, artist page,
and modals.

### Password gate

Optional: one password in front of the whole app when it's reachable
from the public internet. See Setup.

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
only). A plaintext dev password is hashed on first boot and the bcrypt
hash is persisted back to `.env` — the gate then survives restarts
without re-locking devices.
Without a password the gate is disabled and the app is open to whoever
can reach the URL. Set `PIXTOK_PUBLIC_HTTPS=true` when the app is
served over HTTPS (Tailscale Funnel) so the gate cookie and the login
proxy's rewritten pixiv cookies keep `Secure`.

### 3. Run

Development (Vite + HMR; the dev proxy injects the API key):

```
cd backend && go run .
cd frontend && npm install && npm run dev
```

- Backend: `127.0.0.1:8080` (loopback only — the frontend dev proxy
  injects a shared API key)
- Frontend: Vite dev server on `:5173`; set `VITE_ALLOWED_HOSTS` in
  `.env` to expose it on a tailnet/funnel

Production (single binary serving the built frontend):

```
cd frontend && npm run build      # → backend/static (embedded)
cd backend && go build -o pixtok-server .
./pixtok-server                   # serves app + API on 127.0.0.1:8080
```

Prod serving needs `PIXTOK_SERVE_FRONTEND=true` and an enabled gate —
without a gate password the backend refuses to boot (fail-closed). In
this mode the gate cookie is the API credential (the browser can't hold
the API key, so the key is ignored), and Tailscale `serve --bg 8080`
gives the phone a stable HTTPS URL.

## Deployment security

pixtok holds permanent Pixiv credentials — treat the machine running it
like a password vault entry. How you expose it matters more than the
gate:

- **Best:** private network (Tailscale, WireGuard) + HTTPS + optional
  gate. Nobody outside the network can even reach the app; the gate is
  then pure defense-in-depth. This is how pixtok is deployed.
- **Acceptable:** reverse proxy (Caddy/nginx) + HTTPS + strong
  authentication + gate, for a deliberate public hostname.
- **Risky:** direct public exposure with only the gate password. The
  gate is a small custom application standing in as your entire
  internet-facing perimeter.

The password gate is application-level authentication, not a network
boundary — keep it enabled, but don't let it be the only thing between
the internet and your Pixiv session. Tailscale Funnel is not recommended
unless you need access from a device that can't join the tailnet; every
device in this project's use case can.

## Tech

- **Backend:** Go — proxies the Pixiv app API and web AJAX endpoints,
  token rotation, image CDN proxy with in-memory caching, SQLite prefs
  (blocked tags, image quality), password gate
- **Frontend:** SolidJS + Vite — scroll-snap feed, IntersectionObserver
  lazy loading/unloading, canvas ugoira playback, localStorage session
  snapshots
