# Remote Encoder — Self-Hosting Guide

Free, self-hosted encoder remote by [PROVID](https://provid.gg).

## Quick Start

**1.** Edit `docker-compose.yml` and set `BASE_URL` to your public-facing domain:

```yaml
environment:
  BASE_URL: https://your-domain.com
```

**2.** Start the container:

```bash
docker compose up -d
```

On every boot the container injects `BASE_URL` into the HTML Open Graph tags and the encoder install script automatically. No manual find-and-replace, no image rebuild needed — just update the env var and restart.

The app runs on `http://localhost:3000` by default. Put it behind a reverse proxy (nginx, Caddy, etc.) to expose it on your domain.

---

## Environment Variables

Configured in `.env` (copy from `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on (integer, 1–65535) |
| `NODE_ENV` | `production` | Node environment |
| `BASE_URL` | — | Your public URL, e.g. `https://your-domain.com`. The hostname is derived from this automatically — no separate variable needed. Set before building. |

---

## Domain Injection (what happens on boot)

On every container start, `BASE_URL` is injected into:

**HTML files** — Open Graph `og:url` and `og:image` tags in:
- `public/index.html`
- `public/connect.html`
- `public/encoders/bela/control.html`

**Install script** — `public/encoders/bela/scripts/install`:
- The display URLs in the banner and usage hint
- The `sed` patch line that writes your hostname into the device firmware (the functional one — if this is wrong, installed devices won't connect to your server)

If `BASE_URL` is not set or matches the default (`https://rencoder.provid.gg`), the injection is skipped and files stay unchanged.

---

## Footer / Legal Links

Every page footer contains:

- **"Remote Encoder by PROVID"** — keep this as-is. It links to `provid.gg` and that's intentional.
- **Imprint / Privacy links** — these point to PROVID's own legal pages and are **not valid for your instance**. Replace them with links to your own legal pages, or remove them.

| File | Lines to update |
|------|----------------|
| `public/index.html` | 267–268 |
| `public/connect.html` | 119, 126 |
| `public/encoders/bela/control.html` | 431–432 |

---

## WebSocket Endpoints

| Purpose | Path |
|---------|------|
| Device (encoder) | `wss://your-domain/ws/belaboxremote` |
| Viewer | `wss://your-domain/ws/viewer/:key` |

The server validates that WebSocket connections come from the same host, so no extra CORS config is needed as long as your reverse proxy passes `Host` and `Origin` headers correctly.
