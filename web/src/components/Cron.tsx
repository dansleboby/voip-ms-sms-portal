import { t } from '../i18n';
import { Ago, useNow } from './ui';
import type { SyncStatusDto } from '../../../shared/types';

export type CronInfo = NonNullable<SyncStatusDto['cron']>;

/** It should run every minute; some hosts only allow every 15. */
const CRON_LATE_MS = 20 * 60_000;

/** Whether the PHP version's cron job runs: it checks VoIP.ms while the app is closed. */
export function cronState(cron: CronInfo, now: number): 'ok' | 'late' | 'never' {
  if (cron.lastRunAt === null) return 'never';
  return now - cron.lastRunAt > CRON_LATE_MS ? 'late' : 'ok';
}

/** A green "Running" badge (or a red one) and when the job last ran. */
export function CronStatus({ cron }: { cron: CronInfo }) {
  const state = cronState(cron, useNow());
  return (
    <span className="cron-status">
      <span className={`status-pill${state === 'ok' ? '' : ' warn'}`}>{t(`cron.${state}`)}</span>
      {cron.lastRunAt !== null && (
        <span>
          {t('settings.cronLastRun')} <Ago at={cron.lastRunAt} />
        </span>
      )}
    </span>
  );
}
