import { useState, type FormEvent } from 'react';
import { api, ApiError, configProblem } from '../api';
import { errorText, getLang, t } from '../i18n';
import { Logo } from './ui';

/** Where a first install goes wrong, the guide's "Something went wrong?" section. */
const GUIDE = {
  en: 'https://github.com/dansleboby/voip-ms-sms-portal/blob/main/docs/install.md#something-went-wrong',
  fr: 'https://github.com/dansleboby/voip-ms-sms-portal/blob/main/docs/install.fr.md#un-problème',
};

function loginError(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'offline';
  if (code === 'wrong_password') return t('login.wrong');
  if (code === 'rate_limited') return t('login.rateLimited');
  // Another page than the portal's answer: the web server's or a proxy's error page.
  if (err instanceof ApiError && code.startsWith('http_')) return t('login.serverError', { status: err.status });
  return code === 'offline' ? t('error.offline') : errorText(code);
}

/** `problem`: what the server said is missing in its setup, when it said so before sign-in. */
export function Login({ problem: setupProblem = null, onSuccess }: { problem?: string | null; onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState(setupProblem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      // A missing config.php used to read as "Lost connection to the server".
      const setup = configProblem(err);
      if (setup) setProblem(setup);
      else setError(loginError(err));
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
          <label className="field">
            <span>{t('login.password')}</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}
          <button className="btn" type="submit" disabled={busy || password.length === 0}>
            {t('login.submit')}
          </button>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {t('login.hint')}
          </p>
        </form>
      </div>
    </main>
  );
}
