# Installer le Portail SMS, pas à pas

*[English version](install.md)*

Ce guide s'adresse à ceux qui n'ont jamais hébergé d'application eux-mêmes. Prévoyez une trentaine de minutes. Si quelque chose ne ressemble pas à ce qui est décrit ici, voyez [Un problème?](#un-problème) à la fin.

## Ce que vous installez

Le Portail SMS est un petit site web privé que vous placez sur un serveur à vous. Il se connecte à votre compte VoIP.ms et affiche les textos de vos numéros VoIP.ms. Une fois en place, vous l'ouvrez depuis n'importe quel navigateur, sur votre ordinateur ou votre téléphone, où vous pouvez aussi l'ajouter à l'écran d'accueil comme une application.

Ce n'est donc pas un logiciel à installer sur votre téléphone ou votre ordinateur : il lui faut un endroit où il tourne en permanence. Il vous faut :

- un **compte VoIP.ms** avec au moins un numéro (un DID);
- **l'un de ces deux endroits** pour faire tourner le portail :

| | **A. Un hébergement web avec cPanel** | **B. Votre propre appareil, avec Docker** |
|---|---|---|
| Ce que c'est | L'hébergement habituel d'un site web, géré avec le panneau cPanel. Beaucoup d'hébergeurs en vendent pour quelques dollars par mois, souvent avec un nom de domaine. | Un appareil toujours allumé : un NAS (Synology, QNAP, Unraid…), un mini-PC, un Raspberry Pi 4 ou 5, ou un serveur loué (VPS). |
| Ce que vous faites | Des clics dans cPanel, sans ligne de commande. | Installer Docker, puis taper une commande. |
| Bon à savoir | Il faut un nom de domaine (comme `votredomaine.com`) dans ce cPanel. | Pour les notifications et l'installation sur téléphone, il doit être joignable en HTTPS, ce qui demande une étape de plus. |

**Vous hésitez?** Choisissez **A** si vous avez déjà un hébergement web, ou si vous préférez éviter la ligne de commande.

Les étapes :

1. [Préparer votre compte VoIP.ms](#1-préparer-votre-compte-voipms) (pour tous)
2. Installer : [A. sur cPanel](#2a-installer-sur-un-hébergement-cpanel) ou [B. avec Docker](#2b-installer-avec-docker)
3. [Assistant de configuration](#3-assistant-de-configuration) (pour tous)
4. [Sur votre téléphone](#4-sur-votre-téléphone)

## 1. Préparer votre compte VoIP.ms

Le portail communique avec VoIP.ms par son *API*, désactivée tant que vous ne l'activez pas. Le site de VoIP.ms est en anglais : les libellés ci-dessous sont ceux qu'il affiche.

1. Connectez-vous à [voip.ms](https://voip.ms) et ouvrez **Main Menu → SOAP & REST/JSON API**.
2. Dans **API Password**, tapez un nouveau mot de passe et cliquez sur **Save API Password**. Ce n'est **pas** votre mot de passe de connexion à VoIP.ms : c'est un deuxième mot de passe, réservé au portail. Notez-le.
3. Cliquez sur **Enable/Disable API** pour que l'API apparaisse comme activée.
4. Laissez cette page ouverte dans un onglet : à l'étape 3, vous y ajouterez une adresse IP.

Vos numéros doivent aussi avoir les SMS activés : l'assistant de configuration s'en charge.

## 2A. Installer sur un hébergement cPanel

Il faut PHP 8.1 ou plus récent, ce que la plupart des hébergeurs ont par défaut. Les libellés de cPanel sont donnés en français, avec l'anglais entre parenthèses.

**Mettre les fichiers sur l'hébergement**

1. Ouvrez la [page des versions](https://github.com/dansleboby/voip-ms-sms-portal/releases). Sous la dernière version, ouvrez **Assets** et téléchargez **`sms-portal-cpanel-x.y.z.zip`** (pas « Source code »).
2. Connectez-vous à cPanel et ouvrez le **Gestionnaire de fichiers** (*File Manager*). Vous arrivez dans votre dossier personnel, celui qui contient `public_html`. Restez-y.
3. Cliquez sur **Charger** (*Upload*), choisissez le zip et attendez la fin du transfert. Revenez ensuite au Gestionnaire de fichiers.
4. Cliquez une fois sur le zip pour le sélectionner, cliquez sur **Extraire** (*Extract*), puis sur **Extraire le(s) fichier(s)**. Deux dossiers apparaissent côte à côte :
   - `sms-portal` : le portail, ses réglages et ses données. Les navigateurs ne le voient jamais.
   - `sms-portal-site` : les pages que chargent les navigateurs.

   Laissez-les où ils sont, l'un à côté de l'autre : ne mettez jamais l'un dans l'autre. Vous pouvez supprimer le zip.

**Lui donner une adresse**

5. Dans cPanel, ouvrez **Domaines** (*Domains*), puis **Créer un nouveau domaine** (*Create A New Domain*).
6. Dans **Domaine**, tapez l'adresse voulue, comme `sms.votredomaine.com`, où `votredomaine.com` est un domaine de ce cPanel.
7. Décochez **Partager la racine du document** (*Share document root*). Dans **Racine du document** (*Document Root*), effacez ce que propose cPanel et tapez exactement `sms-portal-site`. Cliquez sur **Envoyer** (*Submit*).

   Sur les anciennes versions de cPanel, la page s'appelle **Sous-domaines** (*Subdomains*) : réglez sa racine du document à `sms-portal-site` de la même façon.
8. Ouvrez **État SSL/TLS** (*SSL/TLS Status*) et cliquez sur **Exécuter AutoSSL** (*Run AutoSSL*). Le site obtient ainsi le HTTPS (le cadenas), nécessaire aux notifications. Cela peut prendre quelques minutes.

**Choisir le mot de passe du portail**

9. De retour dans le **Gestionnaire de fichiers**, ouvrez le dossier `sms-portal`. Sélectionnez `config.sample.php`, cliquez sur **Copier** (*Copy*), tapez `/sms-portal/config.php` comme destination et confirmez. Vous avez maintenant un fichier `config.php` dans le même dossier.
10. Sélectionnez `config.php` et cliquez sur **Modifier** (*Edit*). Trouvez cette ligne :

    ```php
    'APP_PASSWORD' => '',
    ```

    Tapez un mot de passe entre les deux apostrophes, comme `'APP_PASSWORD' => 'un long mot de passe bien à moi',`, puis cliquez sur **Enregistrer les modifications** (*Save Changes*).

    C'est le mot de passe qui vous servira à vous connecter au portail. Choisissez-le long : qui le connaît peut lire et envoyer vos textos. Évitez le caractère `'` dedans.

Ouvrez maintenant `https://sms.votredomaine.com` et passez à l'[étape 3](#3-assistant-de-configuration). L'assistant se termine par une dernière étape dans cPanel, la tâche cron.

## 2B. Installer avec Docker

1. Installez Docker :
   - sur Windows ou un Mac : [Docker Desktop](https://www.docker.com/products/docker-desktop/);
   - sur Linux : lancez `curl -fsSL https://get.docker.com | sh`;
   - sur un NAS : son application Docker (Container Manager chez Synology, Container Station chez QNAP…). Elle peut créer un « projet » (ou « stack ») à partir du fichier de l'étape suivante.
2. Créez un dossier nommé `sms-portal`. Dedans, créez un fichier nommé `docker-compose.yml` avec ce contenu, et remplacez le mot de passe par le vôtre :

   ```yaml
   services:
     sms-portal:
       image: ghcr.io/dansleboby/voip-ms-sms-portal:latest
       container_name: sms-portal
       restart: unless-stopped
       ports:
         - "8080:8080"
       environment:
         # Le mot de passe qui vous servira à vous connecter au portail. Choisissez-le long.
         APP_PASSWORD: "un long mot de passe bien à moi"
       volumes:
         - ./data:/data
   ```

3. Ouvrez un terminal dans ce dossier et lancez :

   ```bash
   docker compose up -d
   ```

   Sur un NAS, démarrez plutôt le projet.
4. Dans un navigateur, ouvrez `http://localhost:8080` sur ce même ordinateur, ou `http://<adresse IP de l'appareil>:8080` depuis un autre de votre réseau. Passez à l'[étape 3](#3-assistant-de-configuration).

**HTTPS.** Sans lui, le portail fonctionne dans tout navigateur de votre réseau, mais les téléphones refusent les notifications et l'installation. Pour y accéder en HTTPS, et de partout, placez un proxy inverse devant : celui de votre NAS, Caddy, Nginx Proxy Manager ou un tunnel Cloudflare. Ajoutez alors `PUBLIC_URL: "https://sms.votredomaine.com"` et `TRUST_PROXY: "true"` sous `environment`. Le README donne des exemples : [Derrière un proxy inverse](../README.fr.md#derrière-un-proxy-inverse).

**Mise à jour.** Dans le dossier : `docker compose pull && docker compose up -d`. Vos messages restent dans le dossier `data`.

## 3. Assistant de configuration

1. Ouvrez l'adresse du portail et connectez-vous avec le mot de passe choisi (`APP_PASSWORD`).
2. Cliquez sur **Commencer**. L'écran suivant reprend l'étape 1 : cliquez sur **Continuer**.
3. **Identifiants API** : tapez le **courriel** de votre compte VoIP.ms et le **mot de passe API** de l'étape 1 (pas votre mot de passe de connexion à VoIP.ms). Cliquez sur **Vérifier**.
4. **Autoriser l’adresse IP** : l'assistant affiche une adresse, comme `203.0.113.10`.
   1. Copiez-la avec le bouton à côté.
   2. Sur la page API de VoIP.ms ouverte à l'étape 1, collez-la dans **Enable IP Addresses** et cliquez sur **Save IP Addresses**.
   3. De retour dans l'assistant, cliquez sur **Vérifier l’accès**. VoIP.ms peut prendre une minute à appliquer le changement.
   4. Quand l'assistant affiche « Connexion réussie », cliquez sur **Continuer**.
5. **Vos numéros** : donnez à chacun un nom et une couleur si vous voulez. Un numéro dont les SMS sont désactivés peut être activé ici. Cliquez sur **Continuer**.
6. **Historique** : choisissez combien de vos anciens textos récupérer, puis cliquez sur **Terminer**.
7. **cPanel seulement, Vérifications en arrière-plan.** L'assistant affiche une commande comme `/usr/local/bin/php /home/vous/sms-portal/cron.php`. C'est elle qui récupère les nouveaux textos, et envoie les notifications, quand le portail est fermé.
   1. Copiez la commande.
   2. Dans cPanel, ouvrez **Tâches Cron** (*Cron Jobs*). Sous **Ajouter une nouvelle tâche Cron** (*Add New Cron Job*), dans **Paramètres communs** (*Common Settings*), choisissez **Une fois par minute (\* \* \* \* \*)** (*Once Per Minute*).
   3. Collez la commande dans **Commande** (*Command*) et cliquez sur **Ajouter une nouvelle tâche Cron**.
   4. De retour dans l'assistant, attendez qu'il voie la première exécution, dans la minute.
8. Cliquez sur **Ouvrir mes messages**. C'est prêt!

## 4. Sur votre téléphone

- **iPhone ou iPad** (iOS 16.4 ou plus récent) : ouvrez l'adresse du portail dans Safari, touchez **Partager**, puis **Sur l’écran d’accueil**. Ouvrez le portail depuis cette nouvelle icône, puis dans **Réglages**, activez **Notifications push sur cet appareil**. Sur iPhone, les notifications ne fonctionnent que depuis l'icône de l'écran d'accueil.
- **Android** : ouvrez l'adresse dans Chrome. Touchez **Installer** quand le portail le propose, ou **⋮ → Installer l'application** (ou **Ajouter à l'écran d'accueil**). Puis, dans **Réglages**, activez **Notifications push sur cet appareil**.

**Envoyer une notification test**, dans les **Réglages**, vérifie que tout fonctionne.

## Un problème?

| Ce que vous voyez | Quoi faire |
|---|---|
| Une page « **Forbidden** », ou « **Ce dossier est la partie privée du Portail SMS** » | La racine du document de l'adresse n'est pas `sms-portal-site`. Dans cPanel → **Domaines**, elle doit se terminer par `/sms-portal-site`, et ce dossier doit être à côté de `sms-portal`, pas dedans (étape 2A-7). Si elle est bonne, vérifiez les permissions dans le Gestionnaire de fichiers : 644 pour les fichiers, 755 pour les dossiers. |
| La page de connexion affiche « **Le serveur n’est pas encore prêt** » | Elle dit ce qui manque. Le plus souvent `config.php` (étape 2A-9) ou le mot de passe dedans (étape 2A-10). Si elle parle de PHP 8.1 : dans cPanel, ouvrez **MultiPHP Manager** (ou **Select PHP Version**) et choisissez PHP 8.1 ou plus récent pour l'adresse. |
| « **Mot de passe incorrect.** » à la connexion | Le mot de passe est l'`APP_PASSWORD` écrit dans `config.php` (cPanel) ou dans `docker-compose.yml` (Docker), pas votre mot de passe VoIP.ms. |
| « **Courriel ou mot de passe API incorrect.** » dans l'assistant | Utilisez le mot de passe API de l'étape 1, pas votre mot de passe de connexion à VoIP.ms, et le courriel avec lequel vous vous connectez à VoIP.ms. Au besoin, enregistrez un nouveau mot de passe API sur la page de VoIP.ms et tapez-le de nouveau. |
| « **Cette adresse IP n’est pas autorisée dans VoIP.ms.** » | L'adresse affichée par l'assistant n'est pas encore enregistrée dans **Enable IP Addresses** : collez-la, cliquez sur **Save IP Addresses**, attendez une minute, puis cliquez de nouveau sur **Vérifier l’accès**. |
| « **L’API n’est pas activée dans votre compte VoIP.ms.** » | Cliquez sur **Enable/Disable API** sur la page API de VoIP.ms (étape 1, point 3). |
| Les nouveaux textos n'arrivent que quand le portail est ouvert (cPanel) | La tâche cron manque ou s'est arrêtée. Les **Réglages** l'indiquent par une pastille rouge et donnent la commande à ajouter dans cPanel → **Tâches Cron** (étape 3, point 7). |
| Pas de notifications sur le téléphone | L'adresse doit commencer par `https://`. Sur iPhone, ouvrez le portail depuis son icône de l'écran d'accueil. Activez ensuite les notifications dans les **Réglages**, et essayez **Envoyer une notification test**. |
| Docker : la page ne s'ouvre pas | Dans le dossier, `docker compose ps` indique s'il tourne, et `docker compose logs` pourquoi il ne tourne pas. |

Toujours bloqué? [Ouvrez un ticket](https://github.com/dansleboby/voip-ms-sms-portal/issues) en indiquant l'étape où vous êtes et ce que vous voyez à l'écran.
