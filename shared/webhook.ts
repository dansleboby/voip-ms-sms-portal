/**
 * Minutes between the checks of VoIP.ms that still run while it announces
 * texts by calling the portal: it only calls for texts a number receives, not
 * for those sent from other apps, and a call can be lost while the server is
 * down (php/app/src/Webhook.php has the same).
 */
export const WEBHOOK_SAFETY_MINUTES = 15;
