# Installing SMS Portal, step by step

*[Version française](install.fr.md)*

This guide is for people who have never hosted an app of their own. Set aside about 30 minutes. If something does not look like what is described here, see [Something went wrong?](#something-went-wrong) at the end.

## What you are installing

SMS Portal is a small private website that you put on a server of your own. It connects to your VoIP.ms account and shows the texts of your VoIP.ms numbers. Once it runs, you open it from any browser, on your computer or on your phone, where you can also add it to the home screen like an app.

It is not something you install on your phone or on your computer: it needs a place where it runs all the time. You need:

- a **VoIP.ms account** with at least one phone number (a DID);
- **one of these two places** to run the portal:

| | **A. Web hosting with cPanel** | **B. Your own device, with Docker** |
|---|---|---|
| What it is | The usual hosting plan for a website, managed with the cPanel control panel. Many hosts sell them for a few dollars a month, often with a domain name. | A device that stays on: a NAS (Synology, QNAP, Unraid…), a mini PC, a Raspberry Pi 4 or 5, or a rented server (VPS). |
| What you do | Clicks in cPanel, no command line. | Install Docker, then type one command. |
| Good to know | You need a domain name (like `yourdomain.com`) in that cPanel. | To get notifications and install it on a phone, it must be reachable over HTTPS, which takes extra setup. |

**Not sure?** Choose **A** if you already have a website hosting plan, or if you would rather not use a command line.

The steps:

1. [Prepare your VoIP.ms account](#1-prepare-your-voipms-account) (everyone)
2. Install: [A. on cPanel](#2a-install-on-cpanel-web-hosting) or [B. with Docker](#2b-install-with-docker)
3. [Run the setup wizard](#3-run-the-setup-wizard) (everyone)
4. [Use it on your phone](#4-use-it-on-your-phone)

## 1. Prepare your VoIP.ms account

The portal talks to VoIP.ms through its *API*, which is off until you turn it on.

1. Sign in to [voip.ms](https://voip.ms) and open **Main Menu → SOAP & REST/JSON API**.
2. In **API Password**, type a new password and click **Save API Password**. This is **not** your VoIP.ms sign-in password: it is a second password, only for the portal. Write it down.
3. Click **Enable/Disable API**, so that the API shows as enabled.
4. Leave this page open in a browser tab: in part 3, you will add an IP address on it.

Your numbers must also have SMS turned on: the setup wizard does it for you.

## 2A. Install on cPanel web hosting

Your hosting needs PHP 8.4 or later. Most hosts offer it, though not always by default: step 2A-8 shows where to choose it.

**Put the files on your hosting**

1. Open the [releases page](https://github.com/dansleboby/voip-ms-sms-portal/releases). Under the latest version, open **Assets** and download **`sms-portal-cpanel-x.y.z.zip`** (not "Source code").
2. Sign in to cPanel and open **File Manager**. You start in your home folder, the one that contains `public_html`. Stay there.
3. Click **Upload**, choose the zip and wait for the upload to finish. Then go back to File Manager.
4. Click the zip once to select it, click **Extract**, then **Extract File(s)**. Two folders appear side by side:
   - `sms-portal`: the portal, its settings and its data. Browsers never see it.
   - `sms-portal-site`: the pages that browsers load.

   Leave them where they are, next to each other: never put one inside the other. You can delete the zip.

**Give it an address**

5. In cPanel, open **Domains**, then **Create A New Domain**.
6. In **Domain**, type the address you want, such as `sms.yourdomain.com`, where `yourdomain.com` is a domain of this cPanel.
7. Uncheck **Share document root**. In **Document Root**, erase what cPanel suggests and type exactly `sms-portal-site`. Click **Submit**.

   On older cPanel versions, the page is called **Subdomains**: set its **Document Root** to `sms-portal-site` the same way.
8. Open **SSL/TLS Status** and click **Run AutoSSL**. This gives the site HTTPS (the padlock), which notifications need. It can take a few minutes.

   Then open **MultiPHP Manager** (or **Select PHP Version**), tick the new address, choose **PHP 8.4** or a later one and click **Apply**. If the list stops before 8.4, ask your host.

**Choose your portal password**

9. Back in **File Manager**, open the `sms-portal` folder. Select `config.sample.php`, click **Copy**, type `/sms-portal/config.php` as the destination and confirm. You now have a `config.php` file in the same folder.
10. Select `config.php` and click **Edit**. Find this line:

    ```php
    'APP_PASSWORD' => '',
    ```

    Type a password between the two quotes, like `'APP_PASSWORD' => 'a long password of my own',` and click **Save Changes**.

    This is the password you will sign in to the portal with. Make it long: anyone who has it can read and send your texts. Avoid the `'` character in it.

Now open `https://sms.yourdomain.com` and go on to [part 3](#3-run-the-setup-wizard). The wizard ends with one more step in cPanel, the cron job.

## 2B. Install with Docker

1. Install Docker:
   - on Windows or a Mac: [Docker Desktop](https://www.docker.com/products/docker-desktop/);
   - on Linux: run `curl -fsSL https://get.docker.com | sh`;
   - on a NAS: its Docker app (Container Manager on Synology, Container Station on QNAP…). It can create a "project" (or "stack") from the file of the next step.
2. Create a folder named `sms-portal`. In it, create a file named `docker-compose.yml` with this content, and replace the password with one of your own:

   ```yaml
   services:
     sms-portal:
       image: ghcr.io/dansleboby/voip-ms-sms-portal:latest
       container_name: sms-portal
       restart: unless-stopped
       ports:
         - "8080:8080"
       environment:
         # The password you will sign in to the portal with. Make it long.
         APP_PASSWORD: "a long password of my own"
       volumes:
         - ./data:/data
   ```

3. Open a terminal in that folder and run:

   ```bash
   docker compose up -d
   ```

   On a NAS, start the project instead.
4. In a browser, open `http://localhost:8080` on that same computer, or `http://<the device's IP address>:8080` from another one on your network. Go on to [part 3](#3-run-the-setup-wizard).

**HTTPS.** Without it, the portal works in any browser on your network, but phones refuse notifications and installation. To reach it over HTTPS, and from anywhere, put a reverse proxy in front of it: your NAS's own reverse proxy, Caddy, Nginx Proxy Manager or a Cloudflare Tunnel. Then add `PUBLIC_URL: "https://sms.yourdomain.com"` and `TRUST_PROXY: "true"` under `environment`. The README has examples: [Behind a reverse proxy](../README.md#behind-a-reverse-proxy).

**Updating.** In the folder: `docker compose pull && docker compose up -d`. Your messages stay in the `data` folder.

## 3. Run the setup wizard

1. Open the portal's address and sign in with the password you chose (`APP_PASSWORD`).
2. Click **Get started**. The next screen repeats part 1: click **Continue**.
3. **API credentials**: type your VoIP.ms account **email** and the **API password** from part 1 (not your VoIP.ms sign-in password). Click **Verify**.
4. **Allow the IP address**: the wizard shows an address, like `203.0.113.10`.
   1. Copy it with the button next to it.
   2. On the VoIP.ms API page from part 1, paste it in **Enable IP Addresses** and click **Save IP Addresses**.
   3. Back in the wizard, click **Check access**. VoIP.ms can take a minute to apply the change.
   4. When the wizard says "Connected", click **Continue**.
5. **Your numbers**: give each one a name and a color if you like. A number whose SMS is off can be turned on here. Click **Continue**.
6. **Receiving texts**: how the portal learns that a text came in.
   - On cPanel, or with Docker over HTTPS: choose **Instantly, through a VoIP.ms webhook**. The portal sets up your numbers at VoIP.ms itself, and texts then show up within seconds.
   - If a number already sends its texts somewhere else (another app), it says so: click **Replace** to have it call the portal instead. Going back to regular checks gives it its old setting back.
   - With Docker at home, without an HTTPS address, keep **Regular checks**.

   Click **Continue**.
7. **History**: choose how much of your past texts to bring in, then click **Finish**.
8. **cPanel only, Checks in the background.** The wizard shows a command like `/usr/local/bin/php /home/you/sms-portal/cron.php`. It is what fetches new texts, and sends notifications, while the portal is closed. With the webhook on, it still runs, as a safety net, and downloads the pictures of MMS.
   1. Copy the command.
   2. In cPanel, open **Cron Jobs**. Under **Add New Cron Job**, in **Common Settings**, choose **Once Per Minute (\* \* \* \* \*)**.
   3. Paste the command in **Command** and click **Add New Cron Job**.
   4. Back in the wizard, wait until it sees the first run, within a minute.
9. Click **Open my messages**. Done!

## 4. Use it on your phone

- **iPhone or iPad** (iOS 16.4 or later): open the portal's address in Safari, tap **Share**, then **Add to Home Screen**. Open the portal from that new icon, then in **Settings**, turn on **Push notifications on this device**. On an iPhone, notifications only work from the home screen icon.
- **Android**: open the address in Chrome. Tap **Install** when the portal offers it, or **⋮ → Install app** (or **Add to Home screen**). Then, in **Settings**, turn on **Push notifications on this device**.

**Send a test notification**, in **Settings**, checks that everything works.

## Something went wrong?

| What you see | What to do |
|---|---|
| A page saying **"Forbidden"**, or **"This is the private folder of SMS Portal"** | The address's document root is not `sms-portal-site`. In cPanel → **Domains**, it must end with `/sms-portal-site`, and that folder must be next to `sms-portal`, not inside it (step 2A-7). If it is right, check the permissions in File Manager: 644 for files, 755 for folders. |
| The sign-in page says **"The server is not ready yet"** | It says what is missing. Most often `config.php` (step 2A-9) or the password in it (step 2A-10). If it mentions PHP 8.4: in cPanel, open **MultiPHP Manager** (or **Select PHP Version**) and choose PHP 8.4 or later for the address. |
| **"Wrong password."** when you sign in | The password is the `APP_PASSWORD` you wrote in `config.php` (cPanel) or in `docker-compose.yml` (Docker), not your VoIP.ms password. |
| **"Wrong email or API password."** in the wizard | Use the API password from part 1, not your VoIP.ms sign-in password, and the email you sign in to VoIP.ms with. If in doubt, save a new API password on the VoIP.ms page and type it again. |
| **"This IP address is not allowed in VoIP.ms."** | The address the wizard shows is not saved in **Enable IP Addresses** yet: paste it, click **Save IP Addresses**, wait a minute, then click **Check access** again. |
| **"The API is not enabled on your VoIP.ms account."** | Click **Enable/Disable API** on the VoIP.ms API page (part 1, step 3). |
| New texts only show up when the portal is open (cPanel) | The cron job is missing or stopped. **Settings** shows it with a red badge, and gives the command to add in cPanel → **Cron Jobs** (part 3, step 8). Or turn on the webhook (part 3, step 6), which brings texts in without waiting for it. |
| No notifications on the phone | The address must start with `https://`. On an iPhone, open the portal from its home screen icon. Then turn notifications on in **Settings**, and try **Send a test notification**. |
| Docker: the page does not open | In the folder, `docker compose ps` says whether it runs, and `docker compose logs` says why not. |

Still stuck? [Open an issue](https://github.com/dansleboby/voip-ms-sms-portal/issues) and say which step you are at and what you see on the screen.
