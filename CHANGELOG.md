# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/); the running version is shown at the bottom of *Settings*.

## Unreleased

- **Shared hosting (cPanel).** A PHP version of the server (`php/`, PHP 8.1+) runs the same web client on ordinary web hosting, without Docker or Node.js: a zip to extract, a `config.php` to fill in and a cron job that checks VoIP.ms while the app is closed. *Settings* shows when that job last ran, and the command to set it up when it does not. See *Shared hosting (cPanel)* in the README.
- The sign-in page now says "Too many attempts" when sign-ins are rate limited, instead of reporting a lost connection.
- `LIVE_UPDATES=poll` has open tabs ask for updates every 3 s instead of keeping a Server-Sent Events stream open, for proxies and hosts that cannot pass a stream through. The web client follows whichever the server asks for.
- A sent text no longer stays on "Sending…" until the next check when the server's update arrives before the reply to the send (seen in demo mode, where sending is instant).
- *Settings → Last check* now tells how long ago VoIP.ms was last checked ("2 minutes ago", exact time on hover), counting checks that failed, so you can see the checks are still running; when they fail, it also gives the last time one succeeded.

## 1.2.0 (2026-10-03)

- The installed app's icon shows the number of unread texts (iPhone and iPad 16.4+ from the home screen, Chrome and Edge on Windows and macOS), updated by each push notification even when the app is closed, and cleared as conversations are read. Android keeps its own dot for unread notifications.

## 1.1.0 (2026-10-03)

- On phones, the app suggests installing it on the home screen (the browser's own install dialog on Android, the Share steps on iPhone), then turning on push notifications; each suggestion can be put off for good.
- Settings given with quotes (`KEY="value"` in a file passed with `--env-file`, where Docker and Podman keep them) are cleaned up, with a warning in the logs: the VoIP.ms credentials were refused before.
- Phone layout: the number filter chips are spaced again, Settings rows put their buttons under the label when the screen is narrow instead of covering it, and the last conversation scrolls clear of the "Start chat" button.
- The last sync time in Settings no longer shows seconds.

## 1.0.0 (2026-10-03)

First numbered release, covering everything built so far.

- **Messaging**: SMS and MMS on several VoIP.ms numbers (DIDs), each with a name and a color; SMS up to 160 bytes, MMS beyond, never split; attachments (pictures, video, audio, vCard) with in-browser photo resizing; emoji picker; drafts kept per conversation.
- **Reception** by polling VoIP.ms (every 10 s with a tab open, 60 s otherwise), catching up after downtime; received media downloaded and kept locally.
- **Push notifications** (Web Push, VAPID) per device, skipped on the device where the app is on screen.
- **Conversation archive**, with Undo; a new text brings the conversation back.
- **Search** across messages, contact names and numbers, ignoring case and accents.
- **Contacts** with vCard import.
- **Setup wizard**: API access, IP address to allow, numbers, history import.
- Light and dark themes, French and English, installable on phones.
- Self-hosted with Docker (or Podman); single password (`APP_PASSWORD`); `PUBLIC_URL` for reverse proxies that rewrite the `Host` header.
- Open tabs offer to reload when the server runs a newer version.
