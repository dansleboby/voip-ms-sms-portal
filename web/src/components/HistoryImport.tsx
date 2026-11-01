import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { loadSync, toastError, useStore } from '../store';

const CHOICES = [30, 90, 365, 730];

/**
 * Fetches older texts from VoIP.ms: of every account, or of `accountId` only.
 * The progress is the sync status's, summed over the accounts importing.
 */
export function HistoryImportRow({ title, accountId }: { title: string; accountId?: number }) {
  const importing = useStore((s) => s.sync?.importing ?? null);
  const [days, setDays] = useState(90);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (started && !importing) {
      setStarted(false);
      setDone(true);
    }
  }, [started, importing]);

  const start = async () => {
    setDone(false);
    try {
      await api.importHistory(days, accountId);
      // The job is queued before the answer: read it now rather than at the next poll, a few seconds
      // away, or the row would take the import for finished. Not importing any more here means it is.
      await loadSync();
      setStarted(true);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">{title}</div>
        {importing ? (
          <div className="row-sub">{t('sync.importing', importing)}</div>
        ) : (
          done && <div className="row-sub ok-text">✓ {t('settings.importDone')}</div>
        )}
      </div>
      <div className="row-actions">
        <select className="input" style={{ width: 'auto', height: 36 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {CHOICES.map((d) => (
            <option key={d} value={d}>
              {d === 365 ? t('setup.history.year') : t('setup.history.days', { n: d })}
            </option>
          ))}
        </select>
        <button className="btn tonal small" onClick={() => void start()} disabled={!!importing}>
          {importing && <Loader2 size={16} className="spin" />}
          {t('settings.history')}
        </button>
      </div>
    </div>
  );
}
