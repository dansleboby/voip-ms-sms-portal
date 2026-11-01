import { useState, type FormEvent } from 'react';
import { api, ApiError, configProblem } from '../api';
import { errorText, getLang, t } from '../i18n';
import { Logo } from './ui';
import type { PortalMode } from '../../../shared/types';

/** Where a first install goes wrong, the guide's "Something went wrong?" section. */
const GUIDE = {
  en: 'https://github.com/dansleboby/voip-ms-sms-portal/blob/main/docs/install.md#something-went-wrong',
  fr: 'https://github.com/dansleboby/voip-ms-sms-portal/blob/main/docs/install.fr.md#un-problème',
};

function loginError(err: unknown, byEmail: boolean): string {
  const code = err instanceof ApiError ? err.code : 'offline';
  if (code === 'wrong_password') return t(byEmail ? 'login.wrongEmail' : 'login.wrong');
  if (code === 'rate_limited') return t('login.rateLimited');
  // Another page than the portal's answer: the web server's or a proxy's error page.
  if (err instanceof ApiError && code.startsWith('http_')) return t('login.serverError', { status: err.status });
  return code === 'offline' ? t('error.offline') : errorText(code);
}

/**
 * `problem`: what the server said is missing in its setup, when it said so before sign-in.
 * `mode`: in the Team mode, people sign in with their email; the owner can still use APP_PASSWORD.
 */
export function Login({
  problem: setupProblem = null,
  mode = 'simple',
  onSuccess,
}: {
  problem?: string | null;
  mode?: PortalMode;
  onSuccess: () => void;
}) {
  const [byEmail, setByEmail] = useState(mode === 'team');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState(setupProblem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password, byEmail ? email.trim() : undefined);
      onSuccess();
    } catch (err) {
      // A missing config.php used to read as "Lost connection to the server".
      const setup = configProblem(err);
      if (setup) setProblem(setup);
      else setError(loginError(err, byEmail));
      setBusy(false);
    }
  };

  return (
    <main className="center-screen">
      <div className="auth-card">
        <div className="brand">
          <Logo size={48} />
          <div>
            <div className="brand-name">{t('app.name')}</div>
            <div className="brand-tagline">{t('app.tagline')}</div>
          </div>
        </div>
        {problem && (
          <div className="banner error auth-problem" role="alert">
            <div>
              <strong>{t('login.setupProblem')}</strong> {problem}{' '}
              <a href={GUIDE[getLang()]} target="_blank" rel="noreferrer">
                {t('login.guide')}
              </a>
            </div>
          </div>
        )}
        <form onSubmit={submit}>
          {byEmail && (
            <label className="field">
              <span>{t('login.email')}</span>
              <input
                className="input"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>{t('login.password')}</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus={!byEmail}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}
          <button className="btn" type="submit" disabled={busy || password.length === 0 || (byEmail && !email.trim())}>
            {t('login.submit')}
          </button>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {t(byEmail ? 'login.hintEmail' : 'login.hint')}
          </p>
          {mode === 'team' && (
            <button
              type="button"
              className="btn text small"
              style={{ alignSelf: 'flex-start', marginLeft: -12 }}
              onClick={() => {
                setByEmail(!byEmail);
                setError(null);
              }}
            >
              {t(byEmail ? 'login.asOwner' : 'login.asUser')}
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
