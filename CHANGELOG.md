# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/); the running version is shown at the bottom of *Settings*.

## 2.0.0 (2026-10-30)

- **Team mode.** Several people can use the same portal, each with their own email and password. The owner turns it on in *Settings* → *Team mode* by creating the first administrator; it does not turn off. Administrators add users, give them a new password when they forget theirs, suspend or delete them, and choose the numbers each user texts from, read only or with sending. Users see only the settings that concern them: notifications, appearance and their account. The server's `APP_PASSWORD` still opens the portal as its owner, with *Owner sign-in* on the sign-in page. Without Team mode, nothing changes: `APP_PASSWORD` alone opens the portal. The [Team mode guide](docs/team.md) ([en français](docs/team.fr.md)) takes it step by step.
  - A user sees the conversations, pictures, live updates and push notifications of their own numbers only. On a number given to them read only, they read the texts but cannot send, retry or delete any.
  - Each text sent from the portal says who sent it, under the bubble: the user's name (or email), *Owner*, or *You*.
  - For each number, *Settings* → *Numbers* chooses whether everyone shares what is read and archived (the default), or each person keeps their own unread counts and archive. Going back to shared, a conversation someone read counts as read.
  - Each person can hide a number from their own list in *Settings* → *My numbers*, without hiding it for the others.
  - *Settings* → *Activity log* shows the administrators the last 180 days of sign-ins (refused ones too), devices signed out, password changes, changes to users, numbers and VoIP.ms accounts, and deletions, with who did each and from which address.
- **Address books per number.** A contact can be in every number's book (where your contacts are after this update, so nothing changes for them), in the books of some numbers only, or in your own personal book, which only you see. A conversation shows the name from your personal book first, then from its number's. The same phone number can be a different contact in each book. In Team mode, users see the contacts of their numbers' books and change those of the numbers they may text from; every number's book is the administrators'. Imports go to the book you choose.
- **Mute a number.** *Settings* → *My numbers* turns off the notifications of one number and keeps the others.
- **Several VoIP.ms accounts, from Settings.** *Settings* → *VoIP.ms accounts* adds another account (one per client, for instance) step by step: its API access, its credentials, the IP address to allow, then its numbers. Each account can be renamed, tested, and given a new API password.
- **Docker runs the same server as shared hosting.** The image now serves the portal with PHP and Apache, from the same files as the cPanel package, and checks VoIP.ms on its own every few seconds while no tab is open, as before. The portal is the same everywhere, so every new feature reaches both ways of hosting it at once. Updating keeps everything: `docker compose pull && docker compose up -d` opens your data as it is, conversations, contacts, settings, push notifications and the VoIP.ms credentials typed in the wizard (read once, which takes a couple of seconds on the first start) included. What changes:
  - Open tabs ask for news every 3 seconds instead of keeping a connection open: `LIVE_UPDATES` is gone, and a reverse proxy no longer needs response buffering turned off.
  - The logs show errors only, not every request. `LOG_LEVEL`, `HOST` and `WEB_DIR` are no longer read; `PORT`, `TRUST_PROXY`, `PUID` and `PGID` work as before.
  - A mistake in the settings, such as a missing `APP_PASSWORD`, still stops the container, with the reason in its logs.
- **PHP 8.4 or later**, on shared hosting. PHP 8.1 has had no security fixes since the end of 2025, and 8.2 has none after 2026. Choose the version in cPanel (*MultiPHP Manager*, or *Select PHP Version*): with 1.8.1 or later, *Settings* → *Updates* waits for it before installing 2.0, and says so. The Docker image brings its own PHP 8.4.
- **Signed-in devices.** *Settings* → *My account* lists the browsers signed in, with when each was last active, and signs out any of them. Changing your password signs out the others. Signing out now ends a session for good: before, a copy of its cookie kept working until it expired. Everyone signs in again once after this update.
- When several texts from the same person arrive within the same second, as the parts of a long text can, the push notification now shows the last one instead of the first.

## 1.8.1 (2026-10-30)

- Shared hosting: *Settings* → *Updates* now checks that a new version runs on the site's PHP before installing it. Version 2.0 will need PHP 8.4 or later: on an older PHP, it says which version to choose in cPanel (*MultiPHP Manager*) and installs the update once it is chosen, instead of installing a version the site cannot run.

## 1.8.0 (2026-10-29)

- **Texts announced by VoIP.ms.** Instead of checking VoIP.ms on a schedule, the portal can have VoIP.ms call it as soon as one of your numbers receives a text: choose *Instantly, through a VoIP.ms webhook* in the setup wizard or in *Settings* → *Receiving texts*. It needs an address VoIP.ms can reach over HTTPS: shared hosting always has one; with Docker, set `PUBLIC_URL`. The portal sets each number's "SMS/MMS URL Callback" at VoIP.ms itself, keeping the number's other settings. A number that already sends its texts to another address keeps it unless you choose *Replace*, and gets it back when you go back to regular checks. A check still runs every 15 minutes, for texts sent from other apps and calls missed while the server was down. On shared hosting, texts no longer wait for the cron job.

## 1.7.1 (2026-10-22)

- **Step-by-step installation guide** for first-time self-hosters, in English ([docs/install.md](docs/install.md)) and French ([docs/install.fr.md](docs/install.fr.md)): what you need and which option to choose, every click on cPanel web hosting or with Docker, the setup wizard, the phone, and what to do when something goes wrong. The READMEs and the `INSTALL.txt` of the cPanel zip link to it.
- Shared hosting: when the server misses a setup step (no `config.php`, an empty `APP_PASSWORD`, PHP older than 8.1, the `sms-portal` folder not found), the sign-in page now says which, with a link to the guide. It read "Lost connection to the server", and a PHP that was too old gave a blank error.

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
