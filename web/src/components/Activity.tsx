import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import { didName, formatDateTime } from '../lib/format';
import { toastError, useStore } from '../store';
import { describeAgent } from './Team';
import { formatPhone } from '../../../shared/phone';
import type { ActivityDto } from '../../../shared/types';

/** Entries per page: the section keeps its height however far back one goes. */
const PAGE = 15;

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
  const [page, setPage] = useState(0);
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
    let loaded = entries;
    if ((page + 1) * PAGE >= loaded.length && more) {
      setLoading(true);
      try {
        const fetched = await api.activity(loaded.at(-1)?.id);
        loaded = [...loaded, ...fetched.entries];
        setEntries(loaded);
        setMore(fetched.more);
      } catch (err) {
        toastError(err);
        return;
      } finally {
        setLoading(false);
      }
    }
    if ((page + 1) * PAGE < loaded.length) setPage(page + 1);
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
        {entries?.slice(page * PAGE, (page + 1) * PAGE).map((entry) => {
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
      {entries && (page > 0 || (page + 1) * PAGE < entries.length || more) && (
        <div className="pager">
          <button className="btn text" onClick={() => setPage(page - 1)} disabled={page === 0 || loading}>
            <ChevronLeft size={18} />
            {t('activity.newer')}
          </button>
          <span className="muted">
            {t('activity.range', { from: page * PAGE + 1, to: Math.min((page + 1) * PAGE, entries.length) })}
          </span>
          <button className="btn text" onClick={() => void older()} disabled={loading || ((page + 1) * PAGE >= entries.length && !more)}>
            {t('activity.older')}
            {loading ? <Loader2 size={18} className="spin" /> : <ChevronRight size={18} />}
          </button>
        </div>
      )}
    </section>
  );
}
