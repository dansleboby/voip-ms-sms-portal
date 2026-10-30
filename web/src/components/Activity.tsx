import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import { didName, formatDateTime } from '../lib/format';
import { toastError, useStore } from '../store';
import { describeAgent } from './Team';
import { formatPhone } from '../../../shared/phone';
import type { ActivityDto } from '../../../shared/types';

/** Entries shown before "Older". */
const FIRST = 15;

/** What an entry was about, readable: a device for sign-ins, a phone number for numbers and conversations. */
function target(entry: ActivityDto): string | null {
  if (entry.action === 'sign_in' || entry.action === 'session_ended') return describeAgent(entry.target);
  if (entry.target && /^\d{10}$/.test(entry.target)) return formatPhone(entry.target);
  return entry.target;
}

/** Sign-ins, refused ones too, and changes to users, numbers and accounts, for the admins. */
export function ActivitySection() {
  const dids = useStore((s) => s.dids);
  const [entries, setEntries] = useState<ActivityDto[] | null>(null);
  const [more, setMore] = useState(false);
  const [shown, setShown] = useState(FIRST);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .activity()
      .then((page) => {
        setEntries(page.entries);
        setMore(page.more);
      })
      .catch(toastError);
  }, []);

  const older = async () => {
    if (!entries) return;
    if (shown < entries.length) return setShown((n) => n + FIRST * 2);
    setLoading(true);
    try {
      const page = await api.activity(entries.at(-1)?.id);
      setEntries([...entries, ...page.entries]);
      setMore(page.more);
      setShown((n) => n + FIRST * 2);
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  };

  const details = (entry: ActivityDto): string[] => {
    const d = entry.detail ?? {};
    return [
      ...(d.changes ?? []).map((field) => t(`activity.field.${field}` as MessageKey)),
      d.did ? didName(dids.find((x) => x.did === d.did), d.did) : '',
      d.count && d.count > 1 ? String(d.count) : '',
      d.days ? t('activity.days', { days: d.days }) : '',
      d.voipms ? t('activity.alsoVoipms') : '',
    ].filter(Boolean);
  };

  return (
    <section className="section">
      <h3>{t('activity.title')}</h3>
      <p>{t('activity.intro')}</p>
      <div className="card">
        {entries === null && <div className="row muted">{t('common.loading')}</div>}
        {entries?.length === 0 && <div className="row muted">{t('activity.empty')}</div>}
        {entries?.slice(0, shown).map((entry) => {
          const what = target(entry);
          const extra = details(entry);
          const who = entry.actor === null ? t('activity.nobody') : (entry.actor.name ?? t('team.owner'));
          return (
            <div className="row" key={entry.id}>
              <div className="row-main">
                <div className={entry.action === 'sign_in_failed' ? 'row-title error-text' : 'row-title'}>
                  {what
                    ? t('activity.withTarget', { action: t(`activity.action.${entry.action}` as MessageKey), target: what })
                    : t(`activity.action.${entry.action}` as MessageKey)}
                </div>
                {extra.length > 0 && <div className="row-sub">{extra.join(' · ')}</div>}
                <div className="row-sub">{[who, formatDateTime(entry.at), entry.ip].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          );
        })}
      </div>
      {entries && (shown < entries.length || more) && (
        <button className="btn text" style={{ marginTop: 8 }} onClick={() => void older()} disabled={loading}>
          {loading && <Loader2 size={18} className="spin" />}
          {t('activity.older')}
        </button>
      )}
    </section>
  );
}
