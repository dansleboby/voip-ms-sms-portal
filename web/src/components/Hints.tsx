import { useState, type ReactNode } from 'react';
import { BellRing, Download, Share } from 'lucide-react';
import { t } from '../i18n';
import { isInstalled, isTouchDevice, promptInstall, useCanInstall } from '../lib/install';
import { prefs } from '../lib/prefs';
import { enablePush, pushEnabledHere, pushSupport } from '../lib/push';
import { toast, toastError } from '../store';

type Hint = 'install' | 'push';

const isDismissed = (hint: Hint) => prefs.get(`hint:${hint}`) === 'dismissed';

/**
 * On phones, suggests installing the app, then turning on push
 * notifications: one suggestion at a time, each dismissed for good on this
 * device (both stay available from the browser menu and Settings).
 */
export function Hints() {
  const canInstall = useCanInstall();
  const [dismissed, setDismissed] = useState(() => ({ install: isDismissed('install'), push: isDismissed('push') }));
  const [busy, setBusy] = useState(false);
  if (!isTouchDevice()) return null;

  const dismiss = (hint: Hint) => {
    prefs.set(`hint:${hint}`, 'dismissed');
    setDismissed((d) => ({ ...d, [hint]: true }));
  };
  const support = pushSupport();

  if (!isInstalled() && !dismissed.install && (canInstall || support === 'ios-install')) {
    // Safari on iPhone cannot open an install dialog: explain the steps instead.
    const ios = !canInstall;
    const install = async () => {
      if (await promptInstall()) dismiss('install');
    };
    return (
      <HintBanner icon={ios ? <Share size={20} /> : <Download size={20} />} text={ios ? t('hint.installIos') : t('hint.install')}>
        <button className="btn text small" onClick={() => dismiss('install')}>
          {ios ? t('hint.understood') : t('hint.later')}
        </button>
        {!ios && (
          <button className="btn tonal small" onClick={() => void install()}>
            {t('hint.installButton')}
          </button>
        )}
      </HintBanner>
    );
  }

  if (support === 'ok' && !dismissed.push && !pushEnabledHere() && Notification.permission !== 'denied') {
    const turnOn = async () => {
      setBusy(true);
      try {
        const result = await enablePush();
        if (result === 'ok') toast(t('hint.pushOn'));
        else toast(t('settings.notifBlocked'), 'error');
        dismiss('push');
      } catch (err) {
        toastError(err);
      } finally {
        setBusy(false);
      }
    };
    return (
      <HintBanner icon={<BellRing size={20} />} text={t('hint.push')}>
        <button className="btn text small" onClick={() => dismiss('push')}>
          {t('hint.later')}
        </button>
        <button className="btn tonal small" onClick={() => void turnOn()} disabled={busy}>
          {t('hint.pushButton')}
        </button>
      </HintBanner>
    );
  }
  return null;
}

function HintBanner({ icon, text, children }: { icon: ReactNode; text: string; children: ReactNode }) {
  return (
    <div className="banner info hint" role="status">
      <span className="hint-icon">{icon}</span>
      <div className="hint-body">
        <p>{text}</p>
        <div className="hint-actions">{children}</div>
      </div>
    </div>
  );
}
