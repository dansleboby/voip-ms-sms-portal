import { Bell, BellOff, Eye, EyeOff } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { didName } from '../lib/format';
import { loadConversations, loadDids, toastError, useStore } from '../store';
import { formatPhone } from '../../../shared/phone';
import type { DidDto } from '../../../shared/types';

/**
 * What each person chooses for the numbers they see, for themselves: mute
 * one's notifications, and in the Team mode hide one from their list (the
 * admins' switch in Numbers hides it for everyone).
 */
export function MyNumbersSection() {
  const session = useStore((s) => s.session);
  const dids = useStore((s) => s.dids);
  const team = session?.mode === 'team';
  const numbers = dids.filter((d) => d.visible && d.smsEnabled);
  if (numbers.length < 2) return null;

  const update = async (did: DidDto, patch: Partial<Pick<DidDto, 'hidden' | 'muted'>>) => {
    try {
      await api.updateMyDid(did.did, patch);
      await loadDids();
      if ('hidden' in patch) await loadConversations();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <section className="section">
      <h3>{t('myNumbers.title')}</h3>
      <p>{t(team ? 'myNumbers.introTeam' : 'myNumbers.intro')}</p>
      <div className="card">
        {numbers.map((d) => (
          <div className="row" key={d.did}>
            <span className="did-dot" style={{ background: d.color }} aria-hidden="true" />
            <div className="row-main">
              <div className="row-title">{didName(d, d.did)}</div>
              <div className="row-sub">
                {[d.label && formatPhone(d.did), d.hidden && t('myNumbers.hiddenState'), d.muted && t('myNumbers.mutedState')]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {team && (
              <button
                type="button"
                className="icon-btn"
                aria-pressed={d.hidden}
                aria-label={t('myNumbers.hide')}
                title={t('myNumbers.hide')}
                onClick={() => void update(d, { hidden: !d.hidden })}
              >
                {d.hidden ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-pressed={d.muted}
              aria-label={t('myNumbers.mute')}
              title={t('myNumbers.mute')}
              onClick={() => void update(d, { muted: !d.muted })}
            >
              {d.muted ? <BellOff size={20} /> : <Bell size={20} />}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
