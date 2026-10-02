# SMS Portal for VoIP.ms

A clean, modern, self-hosted web interface for the texts (SMS/MMS) of your [VoIP.ms](https://voip.ms) numbers, in the spirit of Google Messages for web.

*[Version française](README.fr.md)*

![Conversation view](docs/screenshots/thread.png)

- **All your numbers in one place.** A side rail (filter chips on mobile) switches between "all numbers" and each DID. Give every number a name and a color to recognize it at a glance; each conversation shows which of your numbers it belongs to and replies always leave from that number.
- **Incoming texts without exposing anything to the Internet.** The server polls VoIP.ms: every 10 s while the app is open in a browser, every 60 s otherwise. Messages received while the server was down are fetched when it comes back.
- **SMS or MMS, automatically.** VoIP.ms counts its 160-character SMS limit in *bytes* (an accented letter counts for 2, an emoji for 4). The message box shows the count and switches to MMS when needed, or when you attach a file.
- **Attachments.** Send pictures, videos, audio clips and vCards (up to 3 per message); large photos are resized in the browser to fit VoIP.ms's 1.2 MB limit. Received media is downloaded and kept locally.
- **Setup wizard.** It walks you through enabling the API, shows the exact IP address to whitelist, tests the connection, lists your numbers and imports your history.
- **Contacts** with vCard import (Google Contacts, iCloud, Android…), search, browser notifications, light/dark themes, French and English, installable as an app on phones.

| Mobile | Dark theme | Setup |
| --- | --- | --- |
| ![Mobile](docs/screenshots/mobile.png) | ![Dark](docs/screenshots/dark.png) | ![Setup](docs/screenshots/setup.png) |

## Quick start (Docker)

```bash
git clone https://github.com/dansleboby/voip-ms-sms-portal.git
cd voip-ms-sms-portal
cp .env.example .env        # then set APP_PASSWORD
docker compose up -d --build
```

Open <http://localhost:8080>, sign in with `APP_PASSWORD` and follow the wizard. Data (SQLite database and media) lives in `./data`.

Want to look around first? Start it with `DEMO_MODE=true`: sample numbers and conversations, an auto-reply, and no real texts sent.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `APP_PASSWORD` | *(required)* | Password protecting the interface. Changing it signs everyone out. |
| `VOIPMS_API_USERNAME` / `VOIPMS_API_PASSWORD` | | VoIP.ms account email and API password. Optional: otherwise they are entered in the wizard and stored encrypted with a key derived from `APP_PASSWORD`. |
| `POLL_INTERVAL_ACTIVE` | `10` | Seconds between checks while a browser tab is open. |
| `POLL_INTERVAL_IDLE` | `60` | Seconds between checks when nobody is looking. |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy terminating HTTPS (secure cookies, real client IP). |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and media location. |
| `PORT` | `8080` | HTTP port. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts. |
| `VOIPMS_TIMEZONE` | `America/New_York` | Time zone of the dates VoIP.ms returns. Leave as is. |
| `DEMO_MODE` | `false` | Sample data instead of a real account. |

## Preparing your VoIP.ms account

1. **API access**: in the VoIP.ms portal, *Main Menu → SOAP & REST/JSON API*: set an **API password** (different from your login password) and click *Enable/Disable API*.
2. **Allowed IP**: VoIP.ms only answers API calls from whitelisted addresses. The wizard shows the address VoIP.ms sees for your server; add it under *Enable IP Addresses*. For a home connection whose IP changes, VoIP.ms also accepts ranges (`203.0.113.0/24`), wildcards (`203.0.113.*`) and host names (dynamic DNS).
3. **SMS on your numbers**: *DID Numbers → Manage DID(s)*, edit the number, *Message Service (SMS/MMS)* → enable. By default VoIP.ms limits sending through the API to 100 SMS per day ([messaging@voip.ms](mailto:messaging@voip.ms) can raise it).

## Security

- The VoIP.ms API password **gives access to the whole account** (ordering and cancelling numbers, call routing, voicemail…) and cannot be restricted. Keep this instance private and protected by a strong `APP_PASSWORD`.
- Put it behind HTTPS if you open it to the Internet (see below) and set `TRUST_PROXY=true`.
- Sign-in attempts are rate limited, sessions are signed `HttpOnly`/`SameSite=Lax` cookies and cross-site writes are refused. Received files are served with a sandboxing CSP.

### Behind a reverse proxy

Live updates use Server-Sent Events (`/api/events`): disable response buffering for that path.

**Caddy**

```caddy
sms.example.com {
    reverse_proxy localhost:8080 {
        flush_interval -1
    }
}
```

**nginx**

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # Server-Sent Events
    client_max_body_size 5m;
}
```

## How it works

- **Sync.** `getSMS` and `getMMS` are called separately (with `all_messages=1` VoIP.ms mixes both kinds without saying which is which, and their ids overlap). Each message is stored once, keyed by kind and VoIP.ms id; messages sent from elsewhere (your phone, the VoIP.ms portal) show up too. The very first sync and history imports do not mark anything unread.
- **Dates.** VoIP.ms returns US Eastern wall-clock times; its `timezone` parameter ignores daylight saving time, so dates are converted with the IANA zone instead.
- **Sending.** A message is saved immediately and delivered in the background; if VoIP.ms fails ambiguously (timeout, Cloudflare 5xx) and the message still went out, it is matched with the history instead of appearing twice. Failed messages can be retried.
- **Stack.** Node.js 22+, Fastify, SQLite (better-sqlite3), React + Vite, TypeScript everywhere. A single container, no external service.

## Development

```bash
npm install
DEMO_MODE=true APP_PASSWORD=dev npm run dev   # API on :8080, UI on http://localhost:5173
npm test                                      # unit and API tests
npm run typecheck
npm run build && APP_PASSWORD=dev npm start   # production build
```

If your network goes through an HTTP proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) to use `HTTPS_PROXY`.

## Roadmap ideas

- Optional VoIP.ms webhook/URL callback for instant delivery when the instance is reachable from the Internet
- Web Push notifications when no tab is open
- Deleting messages, archiving conversations, accent-insensitive search

## License

[Apache 2.0](LICENSE). Not affiliated with VoIP.ms.
