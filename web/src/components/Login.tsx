import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { t } from '../i18n';
import { Logo } from './ui';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
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
      const code = err instanceof ApiError ? err.code : 'offline';
      setError(code === 'wrong_password' ? t('login.wrong') : code === 'rate_limited' ? t('login.rateLimited') : t('error.offline'));
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
          {error && <div className="error-text" role="alert">{error}</div>}
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
