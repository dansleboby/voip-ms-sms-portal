import { t } from '../i18n';
import { displayName, didName } from './format';
import { prefs } from './prefs';
import { navigate } from './router';
import type { ConversationDto, DidDto, MessageDto } from '../../../shared/types';

export function notificationsSupported(): boolean {
  return 'Notification' in window;
}

export function notificationsEnabled(): boolean {
  return notificationsSupported() && Notification.permission === 'granted' && prefs.get('notify') !== 'off';
}

export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  prefs.set('notify', permission === 'granted' ? 'on' : 'off');
  return permission === 'granted';
}

export function disableNotifications(): void {
  prefs.set('notify', 'off');
}

export function soundEnabled(): boolean {
  return prefs.get('sound') !== 'off';
}

let audio: AudioContext | null = null;

/** Short two-note chime synthesized on the fly (no audio file to ship). */
function chime(): void {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(audio!.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {
    // Autoplay policies may block audio until the user interacts with the page.
  }
}

export function notifyIncoming(message: MessageDto, conversation: ConversationDto, dids: DidDto[]): void {
  if (soundEnabled()) chime();
  if (!notificationsEnabled()) return;
  const did = dids.find((d) => d.did === conversation.did);
  const title = displayName(conversation.phone, conversation.contact);
  const text = message.body || (message.attachments.length ? `📎 ${t('list.photo')}` : '');
  const body = dids.filter((d) => d.visible).length > 1 ? `${text}\n— ${didName(did, conversation.did)}` : text;
  try {
    const n = new Notification(title, { body, tag: `conversation-${conversation.id}`, icon: '/icon.svg' });
    n.onclick = () => {
      window.focus();
      navigate({ name: 'conversation', id: conversation.id });
      n.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
