import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import { errorText, t } from '../i18n';
import { enableNotifications, notificationsSupported } from '../lib/notify';
import { loadDids, toastError, useStore } from '../store';
import { DidEditor } from './DidEditor';
import { Logo } from './ui';
import type { ConnectionTestDto, DidDto, SetupStatusDto } from '../../../shared/types';

type Step = 'welcome' | 'api' | 'creds' | 'ip' | 'numbers' | 'history' | 'done';
const STEPS: Step[] = ['welcome', 'api', 'creds', 'ip', 'numbers', 'history', 'done'];
const API_PAGE = 'https://voip.ms/m/api.php';
const HISTORY_CHOICES = [0, 7, 30, 90, 365];

export function Setup({ onDone, pollActive, pollIdle }: { onDone: () => void; pollActive: number; pollIdle: number }) {
  const [step, setStep] = useState<Step>('welcome');
  const [status, setStatus] = useState<SetupStatusDto | null>(null);
  const [connection, setConnection] = useState<ConnectionTestDto | null>(null);

  useEffect(() => {
    api.setupStatus().then(setStatus).catch(toastError);
  }, []);

  const fromEnv = status?.credentialsSource === 'env';
  const visibleSteps = STEPS.filter((s) => !(s === 'creds' && fromEnv));
  const index = visibleSteps.indexOf(step);
  const next = () => setStep(visibleSteps[Math.min(index + 1, visibleSteps.length - 1)]!);
  const back = () => setStep(visibleSteps[Math.max(index - 1, 0)]!);

  return (
    <main className="center-screen">
      <div className="setup-card">
        <div className="brand">
          <Logo size={40} />
          <div>
            <div className="brand-name">{t('app.name')}</div>
            <div className="brand-tagline">{t('app.tagline')}</div>
          </div>
        </div>
        <div className="setup-steps" aria-label={t('setup.step', { n: index + 1, total: visibleSteps.length })}>
          {visibleSteps.map((s, i) => (
            <span key={s} className={i <= index ? 'done' : ''} />
          ))}
        </div>
        {step === 'welcome' && <Welcome onNext={next} />}
        {step === 'api' && <ApiStep onNext={next} onBack={back} />}
        {step === 'creds' && (
          <CredentialsStep
            status={status}
            onBack={back}
            onNext={(result) => {
              setConnection(result);
              next();
            }}
          />
        )}
        {step === 'ip' && <IpStep initial={connection} fromEnv={fromEnv} username={status?.username ?? null} onBack={back} onNext={next} />}
        {step === 'numbers' && <NumbersStep onBack={back} onNext={next} />}
        {step === 'history' && <HistoryStep onBack={back} onNext={next} />}
        {step === 'done' && <DoneStep onDone={onDone} pollActive={pollActive} pollIdle={pollIdle} />}
      </div>
    </main>
  );
}

function Actions({ onBack, children }: { onBack?: () => void; children: React.ReactNode }) {
  return (
    <div className="setup-actions">
      {onBack && (
        <button className="btn text" type="button" onClick={onBack}>
          {t('common.back')}
        </button>
      )}
      <span className="spacer" />
      {children}
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="setup-body">
      <h2>{t('setup.welcome.title')}</h2>
      <p>{t('setup.welcome.body')}</p>
      <p className="muted">{t('setup.welcome.need')}</p>
      <ul>
        <li>{t('setup.welcome.need1')}</li>
        <li>{t('setup.welcome.need2')}</li>
        <li>{t('setup.welcome.need3')}</li>
      </ul>
      <Actions>
        <button className="btn" onClick={onNext} autoFocus>
          {t('setup.welcome.start')}
        </button>
      </Actions>
    </div>
  );
}

function ApiStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div className="setup-body">
      <h2>{t('setup.api.title')}</h2>
      <p>{t('setup.api.intro')}</p>
      <ol>
        <li>{t('setup.api.step1')}</li>
        <li>{t('setup.api.step2')}</li>
        <li className="muted">{t('setup.api.step3')}</li>
      </ol>
      <a className="btn outlined" href={API_PAGE} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'flex-start' }}>
        <ExternalLink size={18} />
        {t('setup.api.open')}
      </a>
      <Actions onBack={onBack}>
        <button className="btn" onClick={onNext}>
          {t('common.continue')}
        </button>
      </Actions>
    </div>
  );
}

function CredentialsStep({
  status,
  onNext,
  onBack,
}: {
  status: SetupStatusDto | null;
  onNext: (result: ConnectionTestDto) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState(status?.username ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onNext(await api.saveCredentials(username.trim(), password));
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err.code) : t('error.offline'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="setup-body" onSubmit={submit}>
      <h2>{t('setup.creds.title')}</h2>
      <p>{t('setup.creds.intro')}</p>
      <label className="field">
        <span>{t('setup.creds.username')}</span>
        <input className="input" type="email" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('setup.creds.password')}</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <p className="muted" style={{ fontSize: 12 }}>
        {t('setup.creds.stored')}
      </p>
      {error && <div className="error-text" role="alert">{error}</div>}
      <Actions onBack={onBack}>
        <button className="btn" type="submit" disabled={busy || !username || !password}>
          {busy && <Loader2 size={18} className="spin" />}
          {t('setup.creds.verify')}
        </button>
      </Actions>
    </form>
  );
}

function IpStep({
  initial,
  fromEnv,
  username,
  onNext,
  onBack,
}: {
  initial: ConnectionTestDto | null;
  fromEnv: boolean;
  username: string | null;
  onNext: () => void;
  onBack: () => void;
}) {
  const [result, setResult] = useState<ConnectionTestDto | null>(initial);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      setResult(await api.testConnection());
    } catch (err) {
      setResult({ ip: result?.ip ?? null, status: err instanceof ApiError ? err.code : 'offline', balance: null });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!initial) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ok = result?.status === 'success';
  const copy = async () => {
    if (!result?.ip) return;
    await navigator.clipboard?.writeText(result.ip).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="setup-body">
      <h2>{t('setup.ip.title')}</h2>
      {fromEnv && username && <p className="muted">{t('setup.creds.env', { username })}</p>}
      <p>{t('setup.ip.intro')}</p>
      <div className="ip-box">
        <div style={{ flex: 1 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            {t('setup.ip.yourIp')}
          </div>
          <code>{result?.ip ?? '…'}</code>
        </div>
        <button className="icon-btn" onClick={copy} aria-label={t('common.copy')} disabled={!result?.ip}>
          {copied ? <Check size={20} /> : <Copy size={20} />}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('setup.ip.dynamic')}
      </p>
      {result && !busy && (
        <div role="status">
          {ok ? (
            <span className="ok-text">✓ {t('setup.ip.ok', { balance: result.balance?.toFixed(2) ?? '—' })}</span>
          ) : (
            <>
              <div className="error-text">{errorText(result.status)}</div>
              {result.status === 'ip_not_enabled' && <div className="muted" style={{ fontSize: 13 }}>{t('setup.ip.waiting')}</div>}
            </>
          )}
        </div>
      )}
      <Actions onBack={onBack}>
        {!ok && (
          <button className="btn tonal" onClick={check} disabled={busy}>
            {busy ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
            {t('setup.ip.check')}
          </button>
        )}
        <button className="btn" onClick={onNext} disabled={!ok}>
          {t('common.continue')}
        </button>
      </Actions>
    </div>
  );
}

function NumbersStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [dids, setDids] = useState<DidDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      setDids(await api.refreshDids());
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const withSms = dids?.filter((d) => d.smsEnabled) ?? [];
  return (
    <div className="setup-body">
      <h2>{t('setup.numbers.title')}</h2>
      <p>{t('setup.numbers.intro')}</p>
      {dids === null ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          {withSms.length === 0 && <div className="banner warning" style={{ margin: 0 }}>{t('setup.numbers.none')}</div>}
          {dids.length > 0 && (
            <div className="card">
              {dids.map((d) => (
                <DidEditor key={d.did} did={d} onChange={(updated) => setDids((list) => list?.map((x) => (x.did === updated.did ? updated : x)) ?? null)} />
              ))}
            </div>
          )}
          {dids.some((d) => !d.smsEnabled) && <p className="muted" style={{ fontSize: 13 }}>{t('setup.numbers.disabledHint')}</p>}
        </>
      )}
      <Actions onBack={onBack}>
        <button className="btn text" onClick={refresh} disabled={busy}>
          <RefreshCw size={18} className={busy ? 'spin' : ''} />
          {t('setup.numbers.refresh')}
        </button>
        <button className="btn" onClick={onNext} disabled={dids === null}>
          {t('common.continue')}
        </button>
      </Actions>
    </div>
  );
}

function HistoryStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try {
      await api.completeSetup();
      if (days > 0) await api.importHistory(days);
      await loadDids();
      onNext();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <div className="setup-body">
      <h2>{t('setup.history.title')}</h2>
      <p>{t('setup.history.intro')}</p>
      <div className="choice-list" role="radiogroup">
        {HISTORY_CHOICES.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={days === d}
            className="filter-chip"
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {d === 0 ? t('setup.history.none') : d === 365 ? t('setup.history.year') : t('setup.history.days', { n: d })}
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('setup.history.later')}
      </p>
      <Actions onBack={onBack}>
        <button className="btn" onClick={finish} disabled={busy}>
          {busy && <Loader2 size={18} className="spin" />}
          {t('setup.history.finish')}
        </button>
      </Actions>
    </div>
  );
}

function DoneStep({ onDone, pollActive, pollIdle }: { onDone: () => void; pollActive: number; pollIdle: number }) {
  const importing = useStore((s) => s.sync?.importing ?? null);
  const [notif, setNotif] = useState(notificationsSupported() && Notification.permission === 'granted');
  return (
    <div className="setup-body">
      <h2>{t('setup.done.title')}</h2>
      <p>{t('setup.done.body', { active: pollActive, idle: pollIdle })}</p>
      {importing && (
        <div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
            {t('setup.done.importing', importing)}
          </div>
          <div className="progress">
            <div style={{ width: `${(importing.done / Math.max(importing.total, 1)) * 100}%` }} />
          </div>
        </div>
      )}
      <Actions>
        {notificationsSupported() && !notif && (
          <button className="btn tonal" onClick={async () => setNotif(await enableNotifications())}>
            {t('setup.done.notifications')}
          </button>
        )}
        <button className="btn" onClick={onDone} autoFocus>
          {t('setup.done.open')}
        </button>
      </Actions>
    </div>
  );
}
