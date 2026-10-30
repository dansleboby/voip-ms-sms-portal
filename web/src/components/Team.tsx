import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LogOut, Plus, Trash2, Users } from 'lucide-react';
import { api, ApiError } from '../api';
import { errorText, t } from '../i18n';
import { didName, formatDateTime } from '../lib/format';
import { navigate } from '../lib/router';
import { loadSession, resetData, toast, toastError, useStore } from '../store';
import { Ago, Avatar, Dialog, Logo, Switch } from './ui';
import type { SessionInfoDto, UserDto } from '../../../shared/types';

/** As the server asks (server/routes/users.ts). */
const MIN_PASSWORD_LENGTH = 8;

function failure(err: unknown): string {
  return err instanceof ApiError ? errorText(err.code) : t('error.offline');
}

async function signOut(): Promise<void> {
  await api.logout().catch(() => undefined);
  resetData();
  await loadSession();
  navigate({ name: 'home' }, { replace: true });
}

/** What a user sees while the portal is not set up: only whoever manages it can. */
export function NotReady() {
  return (
    <main className="center-screen">
      <div className="auth-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Logo size={48} />
        <p style={{ margin: 0 }}>{t('team.notReady')}</p>
        <button className="btn outlined" style={{ alignSelf: 'flex-start' }} onClick={() => void signOut()}>
          <LogOut size={18} />
          {t('settings.logout')}
        </button>
      </div>
    </main>
  );
}

/** "Chrome · Windows" from a browser's user agent, enough to recognize one's own devices. */
export function describeAgent(ua: string | null): string {
  if (!ua) return t('team.unknownDevice');
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return [browser, system].filter(Boolean).join(' · ') || t('team.unknownDevice');
}

function PasswordField({ label, value, onChange, autoComplete }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="password" autoComplete={autoComplete} minLength={MIN_PASSWORD_LENGTH} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The owner turns the Team mode on by creating its first admin. */
function TeamDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.startTeam({ email: email.trim(), name: name.trim() || null, password });
      await loadSession();
      toast(t('team.started'));
      onClose();
    } catch (err) {
      setError(failure(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('team.start')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p className="dialog-text">{t('team.startIntro')}</p>
        <label className="field">
          <span>{t('team.name')}</span>
          <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('login.email')}</span>
          <input className="input" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <PasswordField label={t('team.password')} value={password} onChange={setPassword} autoComplete="new-password" />
        <p className="dialog-text warning-text">{t('team.startWarning')}</p>
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy || !email.trim() || password.length < MIN_PASSWORD_LENGTH}>
            {t('team.startConfirm')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Adds a user (`user` null) or changes one. */
function UserDialog({ user, self, onClose, onSaved }: { user: UserDto | null; self: boolean; onClose: () => void; onSaved: () => void }) {
  const dids = useStore((s) => s.dids);
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<UserDto['role']>(user?.role ?? 'user');
  const [password, setPassword] = useState('');
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [numbers, setNumbers] = useState<Record<string, boolean>>(() => Object.fromEntries((user?.numbers ?? []).map((n) => [n.did, n.canSend])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setNumber = (did: string, access: 'none' | 'read' | 'send') =>
    setNumbers((list) => {
      const next = { ...list };
      if (access === 'none') delete next[did];
      else next[did] = access === 'send';
      return next;
    });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input = {
      name: name.trim() || null,
      role,
      numbers: Object.entries(numbers).map(([did, canSend]) => ({ did, canSend })),
    };
    try {
      if (user) await api.updateUser(user.id, { ...input, ...(password ? { password } : {}), ...(self ? {} : { disabled }) });
      else await api.createUser({ ...input, email: email.trim(), password });
      onSaved();
      onClose();
    } catch (err) {
      setError(failure(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!user || !window.confirm(t('team.deleteConfirm', { email: user.email }))) return;
    try {
      await api.deleteUser(user.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(failure(err));
    }
  };

  const passwordOk = user ? password.length === 0 || password.length >= MIN_PASSWORD_LENGTH : password.length >= MIN_PASSWORD_LENGTH;

  return (
    <Dialog title={user ? t('team.editUser') : t('team.addUser')} onClose={onClose}>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="field">
          <span>{t('team.name')}</span>
          <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('login.email')}</span>
          <input className="input" type="email" required autoComplete="off" disabled={!!user} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <PasswordField
          label={user ? t('team.newPassword') : t('team.password')}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        {user && <p className="dialog-text" style={{ marginTop: -8, fontSize: 13 }}>{t('team.newPasswordHint')}</p>}
        <div className="field">
          <span>{t('team.role')}</span>
          <div className="segmented" style={{ alignSelf: 'flex-start' }}>
            {(['user', 'admin'] as const).map((value) => (
              <button key={value} type="button" aria-pressed={role === value} disabled={self} onClick={() => setRole(value)}>
                {t(value === 'admin' ? 'team.roleAdmin' : 'team.roleUser')}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 13 }}>
            {t(role === 'admin' ? 'team.roleAdminHint' : 'team.roleUserHint')}
          </span>
        </div>
        {role === 'user' && (
          <div className="field">
            <span>{t('team.numbers')}</span>
            {dids.length === 0 && <span className="muted">{t('team.noNumbers')}</span>}
            {dids.map((d) => {
              const access = numbers[d.did] === undefined ? 'none' : numbers[d.did] ? 'send' : 'read';
              return (
                <div key={d.did} className="row" style={{ padding: '4px 0', minHeight: 0, border: 'none' }}>
                  <div className="row-main row-title">{didName(d, d.did)}</div>
                  <select
                    className="input"
                    style={{ width: 'auto', height: 36 }}
                    aria-label={didName(d, d.did)}
                    value={access}
                    onChange={(e) => setNumber(d.did, e.target.value as 'none' | 'read' | 'send')}
                  >
                    <option value="none">{t('team.accessNone')}</option>
                    <option value="read">{t('team.accessRead')}</option>
                    <option value="send">{t('team.accessSend')}</option>
                  </select>
                </div>
              );
            })}
          </div>
        )}
        {user && !self && (
          <div className="row" style={{ padding: 0, minHeight: 0 }}>
            <div className="row-main">
              <div className="row-title">{t('team.suspend')}</div>
              <div className="row-sub">{t('team.suspendHint')}</div>
            </div>
            <Switch checked={disabled} label={t('team.suspend')} onChange={setDisabled} />
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          {user && !self && (
            <button type="button" className="btn danger" onClick={() => void remove()} aria-label={t('common.delete')} title={t('common.delete')}>
              <Trash2 size={18} />
              <span className="btn-label">{t('common.delete')}</span>
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy || !email.trim() || !passwordOk}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The Team mode in the settings: the owner turns it on; then the admins (and
 * the owner) add the users and give each one their numbers.
 */
export function TeamSection() {
  const session = useStore((s) => s.session);
  const dids = useStore((s) => s.dids);
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);
  const [starting, setStarting] = useState(false);
  const team = session?.mode === 'team';

  const load = useCallback(() => {
    if (team) api.users().then(setUsers).catch(toastError);
  }, [team]);
  useEffect(load, [load]);

  if (!team) {
    // Only the owner can turn it on.
    if (session?.user?.role !== 'owner') return null;
    return (
      <section className="section">
        <h3>{t('team.title')}</h3>
        <p>{t('team.intro')}</p>
        <button className="btn tonal" onClick={() => setStarting(true)}>
          <Users size={18} />
          {t('team.start')}
        </button>
        {starting && <TeamDialog onClose={() => setStarting(false)} />}
      </section>
    );
  }

  const numbersOf = (user: UserDto) =>
    user.role === 'admin'
      ? t('team.allNumbers')
      : user.numbers.length === 0
        ? t('team.noNumber')
        : user.numbers.map((n) => didName(dids.find((d) => d.did === n.did), n.did) + (n.canSend ? '' : ` (${t('team.readOnly')})`)).join(', ');

  return (
    <section className="section">
      <h3>{t('team.users')}</h3>
      <p>{t('team.usersHint')}</p>
      <div className="card">
        {users?.map((user) => (
          <button key={user.id} type="button" className="contact-item" onClick={() => setEditing(user)}>
            <Avatar name={user.name ?? user.email} seed={user.email} />
            <div className="row-main">
              <div className="row-title">
                {user.name ?? user.email}{' '}
                {user.role === 'admin' && <span className="kind-chip">{t('team.roleAdmin')}</span>}{' '}
                {user.disabled && <span className="status-pill warn">{t('team.suspended')}</span>}
              </div>
              <div className="row-sub">
                {user.name ? `${user.email} · ` : ''}
                {numbersOf(user)}
              </div>
            </div>
          </button>
        ))}
      </div>
      <button className="btn text" style={{ marginTop: 8 }} onClick={() => setEditing('new')}>
        <Plus size={18} />
        {t('team.addUser')}
      </button>
      {editing && (
        <UserDialog
          user={editing === 'new' ? null : editing}
          self={editing !== 'new' && editing.id === session?.user?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            load();
            void loadSession();
          }}
        />
      )}
    </section>
  );
}

function NameDialog({ name: initial, onClose }: { name: string | null; onClose: () => void }) {
  const [name, setName] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.updateMe({ name: name.trim() || null });
      await loadSession();
      onClose();
    } catch (err) {
      setError(failure(err));
    }
  };
  return (
    <Dialog title={t('team.name')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="field">
          <span>{t('team.name')}</span>
          <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) {
      setError(t('team.passwordMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({ password: { current, next } });
      toast(t('team.passwordChanged'));
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'wrong_password' ? t('login.wrong') : failure(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('team.changePassword')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PasswordField label={t('team.currentPassword')} value={current} onChange={setCurrent} autoComplete="current-password" />
        <PasswordField label={t('team.newPassword')} value={next} onChange={setNext} autoComplete="new-password" />
        <PasswordField label={t('team.newPasswordAgain')} value={again} onChange={setAgain} autoComplete="new-password" />
        <p className="dialog-text" style={{ fontSize: 13 }}>{t('team.passwordHint', { n: MIN_PASSWORD_LENGTH })}</p>
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy || !current || next.length < MIN_PASSWORD_LENGTH || !again}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Who is signed in, and on which devices; a user also changes their name and password here. */
export function MyAccountSection() {
  const session = useStore((s) => s.session);
  const [sessions, setSessions] = useState<SessionInfoDto[] | null>(null);
  const [dialog, setDialog] = useState<'name' | 'password' | null>(null);
  const user = session?.user;

  const load = useCallback(() => {
    api.sessions().then(setSessions).catch(toastError);
  }, []);
  useEffect(load, [load]);

  const end = async (id: string) => {
    try {
      await api.endSession(id);
      load();
    } catch (err) {
      toastError(err);
    }
  };

  if (!user) return null;
  const owner = user.role === 'owner';
  return (
    <section className="section">
      <h3>{t('team.me')}</h3>
      <div className="card">
        <div className="row">
          <div className="row-main">
            <div className="row-title">{owner ? t('team.owner') : (user.name ?? user.email)}</div>
            <div className="row-sub">
              {owner ? t('team.ownerHint') : `${user.name ? `${user.email} · ` : ''}${t(user.role === 'admin' ? 'team.roleAdmin' : 'team.roleUser')}`}
            </div>
          </div>
          {!owner && (
            <div className="row-actions">
              <button className="btn outlined small" onClick={() => setDialog('name')}>
                {t('team.changeName')}
              </button>
              <button className="btn outlined small" onClick={() => setDialog('password')}>
                {t('team.changePassword')}
              </button>
            </div>
          )}
        </div>
        {sessions?.map((s) => (
          <div key={s.id} className="row">
            <div className="row-main">
              <div className="row-title">
                {describeAgent(s.userAgent)} {s.current && <span className="status-pill">{t('team.thisDevice')}</span>}
              </div>
              <div className="row-sub">
                {t('team.signedInAt', { when: formatDateTime(s.createdAt) })}
                {!s.current && (
                  <>
                    {' · '}
                    {t('team.lastSeen')} <Ago at={s.lastSeenAt} />
                  </>
                )}
              </div>
            </div>
            {!s.current && (
              <button className="btn text small" onClick={() => void end(s.id)}>
                {t('team.endSession')}
              </button>
            )}
          </div>
        ))}
      </div>
      {dialog === 'name' && <NameDialog name={user.name} onClose={() => setDialog(null)} />}
      {dialog === 'password' && <PasswordDialog onClose={() => setDialog(null)} onChanged={load} />}
    </section>
  );
}
