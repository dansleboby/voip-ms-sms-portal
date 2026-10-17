<?php

/*
 * Settings of the SMS Portal. Copy this file to config.php, in this same
 * folder, and set at least APP_PASSWORD.
 *
 * Each setting can also come from an environment variable of the same name,
 * which then takes precedence.
 */

return [
    // Password protecting the web interface (required). Changing it signs everyone out.
    'APP_PASSWORD' => '',

    // VoIP.ms account email and API password. Optional: leave them empty to enter
    // them in the setup wizard, which stores them encrypted with a key derived from
    // APP_PASSWORD. The API password is set in the VoIP.ms portal:
    // Main Menu > SOAP & REST/JSON API.
    'VOIPMS_API_USERNAME' => '',
    'VOIPMS_API_PASSWORD' => '',

    // Seconds between checks for new messages while the app is open in a browser,
    // and when nobody is looking (the cron job runs them, at most once a minute).
    'POLL_INTERVAL_ACTIVE' => 10,
    'POLL_INTERVAL_IDLE' => 60,

    // Address of the app, like https://sms.example.com. Recommended: sign-ins are
    // refused when a proxy in front of the site does not pass the original Host along.
    'PUBLIC_URL' => '',

    // Contact sent to browser push services with each notification
    // (mailto:you@example.com or an https:// URL).
    'VAPID_SUBJECT' => '',

    // Where the database and media are stored. The default, "data" next to this
    // file, is right for almost everyone.
    'DATA_DIR' => __DIR__ . '/data',

    // Days a sign-in lasts.
    'SESSION_DAYS' => 30,

    // Time zone of the dates VoIP.ms returns. Leave as is.
    'VOIPMS_TIMEZONE' => 'America/New_York',

    // The only numbers of the account the portal uses, like ['514 555-0100', '450-555-0199'],
    // and numbers it must leave alone. The others do not show up anywhere and their
    // texts are not fetched. Empty: every number of the account.
    'ALLOWED_DIDS' => [],
    'EXCLUDED_DIDS' => [],

    // Sample data instead of a real VoIP.ms account, to try the interface.
    'DEMO_MODE' => false,

    // Look for new versions (Settings > Updates asks GitHub for the newest release).
    'UPDATE_CHECK' => true,
];
