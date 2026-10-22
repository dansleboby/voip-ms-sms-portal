# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/); the running version is shown at the bottom of *Settings*.

## 1.7.0 (2026-10-22)

- **Deleting contacts in bulk.** *Select* on the Contacts page lets you tick contacts, or all of them at once with *Select all* (after a search, all the contacts it found), and delete them together; their conversations stay, under their phone numbers. Before, contacts could only be deleted one at a time.
- Right after a vCard import, the message offers *Undo*, which removes the contacts the import added: the wrong file is no longer 500 contacts to delete by hand.

## 1.6.1 (2026-10-21)

- Shared hosting: a document root set on the private `sms-portal` folder, or a site moved inside it, now gets a page saying what to change, in English and French, instead of a bare "Forbidden".
- Shared hosting: updates installed from *Settings* by this version and later leave the site's files readable by the web server, also on hosts where PHP makes the files it writes private to the account. There, every page answered "Forbidden" after an update until the permissions were set right by hand.

## 1.6.0 (2026-10-17)

- **Voice messages play.** The AMR files most phones send voice messages in played in no desktop browser (the player stayed at 0:00): they are now decoded in the browser. Audio attachments get a player of their own, with the recording's waveform as its progress bar (tap or drag it to move around), the time, and a 1×, 1.5× or 2× speed.
- A voice message no longer comes with a tall empty bubble: VoIP.ms gives some of them a text made only of line breaks, which is now dropped, including in messages already received.

## 1.5.1 (2026-10-17)

- On phones, opening the keyboard no longer slides the conversation up out of sight: the header stays, the latest messages stay right above the message box, and the box is no longer half under the keyboard. A short conversation now sits right above the message box, like the end of a long one.
- On narrow phones, the contact dialog's *Delete* button shows its bin alone instead of sticking out of the dialog.

## 1.5.0 (2026-10-17)

- **Deleting messages and conversations.** Tap a message to delete it, or use the bin in a conversation's header to delete it all. Deleted texts leave the portal for good, on every device, and checking VoIP.ms does not bring them back; a new text brings a deleted conversation back, with that text only. The confirmation offers to delete them at VoIP.ms too (off by default, and for good), which the server does in the background, one message at a time, trying again after a network error.
- On phones, a conversation's actions (contact, archive, delete) are in a ⋮ menu, so its name keeps its room in the header.

## 1.4.0 (2026-10-17)

- **Numbers to use, or to leave alone.** `ALLOWED_DIDS` lists the only numbers of the account the portal uses, `EXCLUDED_DIDS` the ones it leaves alone (for accounts with numbers that belong to someone else). Their texts are not fetched and they show up nowhere; texts stored before stay in the database, hidden, and come back if the number is allowed again. On shared hosting, `config.php` also takes them as lists.
- **Turning SMS on from the portal.** In the wizard and in *Settings*, turning on a number whose SMS is off enables it in your VoIP.ms account, keeping its email, forwarding and callback settings; the row says so beforehand. Numbers that VoIP.ms offers no SMS on stay greyed out. A number that gets SMS in VoIP.ms now shows up on the next refresh.
- **Cron job in the wizard (shared hosting).** When the cron job has not run yet, the wizard gives its command, sees its first run, and says what skipping it costs. *Settings* and that step show a green "Running" badge, or a red one when the job is not set up or seems stopped.
- **Contacts.** Each contact can have its own avatar color, and an icon instead of its initials (home, work, family, car…). Phone numbers are formatted as you type them in the contact dialog.
- Shared hosting: the site's `.htaccess` no longer needs `mod_env`; on hosts without it, every page answered with an error 500.
- The first text sent to a new number no longer stays in the message box once the conversation opens.
- `npm run screenshots` takes the README's screenshots again, and lists the ones whose look changed.

## 1.3.0 (2026-10-17)

- **Releases.** Each version is published on GitHub as it reaches `main`: release notes from this changelog, the shared hosting zip, and the Docker image on `ghcr.io/dansleboby/voip-ms-sms-portal`, which `docker-compose.yml` now uses.
- **Updates in Settings.** *Settings → Updates* says when a new version is out, with what changed. The shared hosting version installs it in one click, after checking the download against the release's SHA-256 and keeping the files it replaces; Docker shows the command to run. `UPDATE_CHECK=false` turns the check off.
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
