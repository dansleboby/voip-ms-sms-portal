# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/); the running version is shown at the bottom of *Settings*.

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
