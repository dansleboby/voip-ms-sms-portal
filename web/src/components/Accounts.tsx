import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import { errorText, t } from '../i18n';
import { navigate } from '../lib/router';
import { loadDids, toast, toastError, useStore } from '../store';
import { DidEditor } from './DidEditor';
import { Dialog } from './ui';
import type { AccountCheckDto, AccountDto, ConnectionTestDto } from '../../../shared/types';

const API_PAGE = 'https://voip.ms/m/api.php';

/** What VoIP.ms answered about an account, from a request that failed or not. */
function failed(err: unknown): ConnectionTestDto {
  return { ip: null, status: err instanceof ApiError ? err.code : 'offline', balance: null };
}

/** VoIP.ms's answer: the balance, or what is wrong; the IP to allow when that is it. */
function ConnectionResult({ connection }: { connection: ConnectionTestDto }) {
  const [copied, setCopied] = useState(false);
  const ok = connection.status === 'success';
  const copy = async () => {
    if (!connection.ip) return;
    await navigator.clipboard?.writeText(connection.ip).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ok ? (
        <span className="ok-text">✓ {t('setup.ip.ok', { balance: connection.balance?.toFixed(2) ?? '—' })}</span>
      ) : (
        <span className="error-text">{errorText(connection.status)}</span>
      )}
      {!ok && connection.ip && (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('setup.ip.intro')}
          </p>
          <div className="ip-box">
            <div style={{ flex: 1 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                {t('setup.ip.yourIp')}
              </div>
              <code>{connection.ip}</code>
            </div>
            <button type="button" className="icon-btn" onClick={copy} aria-label={t('common.copy')}>
              {copied ? <Check size={20} /> : <Copy size={20} />}
            </button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('setup.ip.waiting')}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The VoIP.ms accounts the portal uses (an agency keeps one per client): each
 * one's name, credentials and connection, and adding another.
 */
export function AccountsSection() {
  const demo = useStore((s) => s.session?.demo ?? false);
  const [accounts, setAccounts] = useState<AccountDto[] | null>(null);
  const [results, setResults] = useState<Record<number, ConnectionTestDto | 'busy'>>({});
  const [editing, setEditing] = useState<AccountDto | 'new' | null>(null);

  const load = () => api.accounts().then(setAccounts).catch(toastError);
  useEffect(() => {
    void load();
  }, []);

  const replace = (account: AccountDto) => setAccounts((list) => list?.map((a) => (a.id === account.id ? account : a)) ?? null);

  const test = async (account: AccountDto) => {
    setResults((r) => ({ ...r, [account.id]: 'busy' }));
    try {
      const check = await api.testAccount(account.id);
      setResults((r) => ({ ...r, [account.id]: check.connection }));
      replace(check.account);
      if (check.connection.status === 'success') await loadDids();
    } catch (err) {
      setResults((r) => ({ ...r, [account.id]: failed(err) }));
    }
  };

  return (
    <section className="section">
      <h3>{t('accounts.title')}</h3>
      <p>{t('accounts.intro')}</p>
      <div className="card">
        {accounts === null && <div className="row muted">{t('common.loading')}</div>}
        {accounts?.map((a) => {
          const result = results[a.id];
          return (
            <div className="row" key={a.id}>
              <div className="row-main">
                <div className="row-title">{a.label || a.username || t('accounts.unnamed')}</div>
                <div className="row-sub">
                  {[
                    a.label && a.username,
                    t('accounts.numbers', { count: a.numbers }),
                    a.credentialsSource === 'env' ? t('settings.credentialsEnv') : a.credentialsSource === null && t('accounts.noCredentials'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {result && result !== 'busy' ? (
                  <div style={{ marginTop: 8 }}>
                    <ConnectionResult connection={result} />
                  </div>
                ) : (
                  a.error && <div className="error-text">{errorText(a.error)}</div>
                )}
              </div>
              <button className="btn tonal small" onClick={() => void test(a)} disabled={result === 'busy' || a.credentialsSource === null}>
                {result === 'busy' && <Loader2 size={16} className="spin" />}
                {t('settings.testConnection')}
              </button>
              <button className="btn outlined small" onClick={() => setEditing(a)}>
                {t('accounts.edit')}
              </button>
            </div>
          );
        })}
        {!demo && (
          <div className="row">
            <div className="row-main row-sub">{t('accounts.wizardHint')}</div>
            <button className="btn outlined small" onClick={() => navigate({ name: 'setup' })}>
              {t('settings.runWizard')}
            </button>
          </div>
        )}
      </div>
      <button className="btn text" style={{ marginTop: 8 }} onClick={() => setEditing('new')}>
        <Plus size={18} />
        {t('accounts.add')}
      </button>
      {editing === 'new' && (
        <AddAccountDialog
          onAdded={(account) => setAccounts((list) => [...(list ?? []), account])}
          onChange={replace}
          onClose={() => setEditing(null)}
        />
      )}
      {editing && editing !== 'new' && (
        <EditAccountDialog
          account={editing}
          onChange={(account, connection) => {
            replace(account);
            if (connection) setResults((r) => ({ ...r, [account.id]: connection }));
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** The fields of an account's credentials, as the setup wizard asks for them. */
function CredentialFields({
  username,
  password,
  onUsername,
  onPassword,
  passwordHint,
}: {
  username: string;
  password: string;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
  passwordHint?: string;
}) {
  return (
    <>
      <label className="field">
        <span>{t('setup.creds.username')}</span>
        <input className="input" type="email" autoComplete="off" required value={username} onChange={(e) => onUsername(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('setup.creds.password')}</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => onPassword(e.target.value)} />
        <small className="muted">{passwordHint ?? t('setup.creds.stored')}</small>
      </label>
    </>
  );
}

/**
 * Adding an account, the way the setup wizard set up the first one: its API
 * access, its credentials, the IP to allow, then its numbers.
 */
function AddAccountDialog({
  onAdded,
  onChange,
  onClose,
}: {
  onAdded: (account: AccountDto) => void;
  onChange: (account: AccountDto) => void;
  onClose: () => void;
}) {
  const allDids = useStore((s) => s.dids);
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<AccountCheckDto | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.addAccount({ label: label.trim() || null, username: username.trim(), password });
      setAdded(result);
      onAdded(result.account);
      await loadDids();
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err.code) : t('error.offline'));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!added) return;
    setBusy(true);
    try {
      const result = await api.testAccount(added.account.id);
      setAdded(result);
      onChange(result.account);
      await loadDids();
    } catch (err) {
      setAdded({ ...added, connection: failed(err) });
    } finally {
      setBusy(false);
    }
  };

  if (added) {
    const ok = added.connection.status === 'success';
    const numbers = allDids.filter((d) => d.accountId === added.account.id);
    return (
      <Dialog title={t('accounts.addedTitle', { name: added.account.label || added.account.username || '' })} onClose={onClose}>
        <ConnectionResult connection={added.connection} />
        {ok && (
          <>
            <p className="dialog-text">{t(numbers.length ? 'accounts.addedNumbers' : 'accounts.addedNoNumbers')}</p>
            {numbers.length > 0 && (
              <div className="card">
                {numbers.map((d) => (
                  <DidEditor key={d.did} did={d} onChange={() => void loadDids()} />
                ))}
              </div>
            )}
          </>
        )}
        <div className="dialog-actions">
          <span className="spacer" />
          {!ok && (
            <button type="button" className="btn tonal" onClick={() => void retry()} disabled={busy}>
              {busy ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
              {t('setup.ip.check')}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t('accounts.add')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="dialog-text">
          <p style={{ marginTop: 0 }}>{t('setup.api.intro')}</p>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>{t('setup.api.step1')}</li>
            <li>{t('setup.api.step2')}</li>
            <li>{t('accounts.ipLater')}</li>
          </ol>
        </div>
        <a className="btn outlined" href={API_PAGE} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'flex-start' }}>
          <ExternalLink size={18} />
          {t('setup.api.open')}
        </a>
        <label className="field">
          <span>{t('accounts.label')}</span>
          <input className="input" maxLength={60} placeholder={t('accounts.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <CredentialFields username={username} password={password} onUsername={setUsername} onPassword={setPassword} />
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy || !username.trim() || !password}>
            {busy && <Loader2 size={18} className="spin" />}
            {t('accounts.addButton')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** An account's name, and new credentials (a new API password) unless the server's settings give them. */
function EditAccountDialog({
  account,
  onChange,
  onClose,
}: {
  account: AccountDto;
  onChange: (account: AccountDto, connection?: ConnectionTestDto) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(account.label ?? '');
  const [username, setUsername] = useState(account.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromEnv = account.credentialsSource === 'env';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let updated = account;
      if ((label.trim() || null) !== account.label) updated = await api.renameAccount(account.id, label.trim() || null);
      let connection: ConnectionTestDto | undefined;
      if (password) {
        const result = await api.setAccountCredentials(account.id, { username: username.trim(), password });
        updated = result.account;
        connection = result.connection;
        await loadDids();
      }
      onChange(updated, connection);
      if (connection && connection.status !== 'success') toast(errorText(connection.status), 'error');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err.code) : t('error.offline'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('accounts.editTitle')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="field">
          <span>{t('accounts.label')}</span>
          <input className="input" maxLength={60} placeholder={t('accounts.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {fromEnv ? (
          <p className="muted dialog-text">{t('setup.creds.env', { username: account.username ?? '' })}</p>
        ) : (
          <CredentialFields
            username={username}
            password={password}
            onUsername={setUsername}
            onPassword={setPassword}
            passwordHint={t('accounts.passwordHint')}
          />
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy || (!!password && !username.trim())}>
            {busy && <Loader2 size={18} className="spin" />}
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
