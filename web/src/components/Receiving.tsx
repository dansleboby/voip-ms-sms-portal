import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Zap } from 'lucide-react';
import { api } from '../api';
import { errorText, t } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import { loadDids, loadSync, toastError, useStore } from '../store';
import { Ago } from './ui';
import { formatPhone } from '../../../shared/phone';
import type { WebhookNumberDto, WebhookStatusDto } from '../../../shared/types';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * How new texts reach the portal: regular checks of VoIP.ms, or VoIP.ms
 * calling the portal (each number's "URL Callback") as soon as one comes in.
 * In Settings and in the setup wizard.
 */
export function ReceivingPanel({ pollActive, pollIdle }: { pollActive: number; pollIdle: number }) {
  const dids = useStore((s) => s.dids);
  const [status, setStatus] = useState<WebhookStatusDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The numbers' names, which the wizard has not loaded yet.
    void loadDids().catch(() => undefined);
    api
      .webhook()
      .then(setStatus)
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : 'offline'));
  }, []);

  // VoIP.ms must reach the portal from the Internet, and the secret in the address must not travel in clear.
  const https = window.location.protocol === 'https:' || !!status?.publicUrl?.startsWith('https:');
  const labelOf = (did: string) => {
    const known = dids.find((d) => d.did === did);
    return known?.label ? `${known.label} · ${formatPhone(did)}` : formatPhone(did);
  };

  const run = async (work: () => Promise<WebhookStatusDto>) => {
    setBusy(true);
    try {
      setStatus(await work());
      await loadSync().catch(() => undefined);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const replace = (number: WebhookNumberDto) => {
    if (!window.confirm(t('receiving.replaceConfirm', { number: labelOf(number.did), url: number.otherUrl ?? '' }))) return;
    const others = status?.numbers.filter((n) => n.state === 'ours').map((n) => n.did) ?? [];
    void run(() => api.enableWebhook([number.did, ...others]));
  };

  if (!status) {
    return (
      <div className="card receiving">
        <div className="row">
          <div className="row-main muted">{failure ? errorText(failure) : t('common.loading')}</div>
        </div>
      </div>
    );
  }

  const enabled = status.enabled;
  return (
    <div className="card receiving">
      <label className={enabled ? 'choice' : 'choice selected'}>
        <input type="radio" name="receiving" checked={!enabled} disabled={busy} onChange={() => void run(() => api.disableWebhook())} />
        <span>
          <span className="check-title">{t('receiving.poll')}</span>
          <span className="check-hint">{t('receiving.pollHint', { active: pollActive, idle: pollIdle })}</span>
        </span>
      </label>
      <label className={enabled ? 'choice selected' : https ? 'choice' : 'choice disabled'}>
        <input
          type="radio"
          name="receiving"
          checked={enabled}
          disabled={busy || (!https && !enabled)}
          onChange={() => void run(() => api.enableWebhook())}
        />
        <span>
          <span className="check-title">
            <Zap size={16} aria-hidden="true" /> {t('receiving.webhook')}
            {https && !enabled && <span className="chip">{t('receiving.recommended')}</span>}
          </span>
          <span className="check-hint">{t('receiving.webhookHint', { minutes: status.safetyMinutes })}</span>
          {!https && <span className="check-hint error-text">{t('receiving.needsHttps')}</span>}
        </span>
        {busy && <Loader2 size={18} className="spin" />}
      </label>

      {enabled && (
        <>
          {status.numbers.map((n) => (
            <div key={n.did} className="row receiving-number">
              <div className="row-main">
                <div className="row-title">{labelOf(n.did)}</div>
                <div className={n.state === 'other' || n.error ? 'row-sub warning-text' : 'row-sub'}>
                  {n.state === 'ours' && <Check size={14} aria-hidden="true" />}
                  {n.state === 'other' && <AlertTriangle size={14} aria-hidden="true" />} {t(`receiving.state.${n.state}` as MessageKey, { host: hostOf(n.otherUrl ?? '') })}
                  {n.error && ` · ${errorText(n.error)}`}
                </div>
              </div>
              {n.state === 'other' && (
                <button className="btn tonal small" disabled={busy} onClick={() => replace(n)}>
                  {t('receiving.replace')}
                </button>
              )}
              {n.state === 'none' && (
                <button className="btn tonal small" disabled={busy} onClick={() => void run(() => api.enableWebhook())}>
                  {t('common.retry')}
                </button>
              )}
            </div>
          ))}
          <div className="row">
            <div className="row-main">
              <div className="row-sub">
                {status.lastCallAt ? (
                  <>
                    {t('receiving.lastCall')} <Ago at={status.lastCallAt} />
                  </>
                ) : (
                  t('receiving.noCall')
                )}
              </div>
              {!status.complete && <div className="row-sub warning-text">{t('receiving.incomplete')}</div>}
            </div>
          </div>
        </>
      )}
      {!enabled && status.numbers.some((n) => n.state === 'ours') && (
        // Turned off while VoIP.ms refused to change a number: it still calls, which does no harm.
        <div className="row">
          <div className="row-main row-sub warning-text">{t('receiving.stillCalling')}</div>
          <button className="btn tonal small" disabled={busy} onClick={() => void run(() => api.disableWebhook())}>
            {t('common.retry')}
          </button>
        </div>
      )}
    </div>
  );
}
