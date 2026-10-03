import { useState } from 'react';
import { ArrowLeft, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import { errorText, getLang, setLang, t, useLang } from '../i18n';
import { disableNotifications, enableNotifications, notificationsEnabled, notificationsSupported, soundEnabled } from '../lib/notify';
import { prefs } from '../lib/prefs';
import { disablePush, enablePush, pushEnabledHere, pushSupport, refreshPush, sendTestPush } from '../lib/push';
import { navigate } from '../lib/router';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { loadDids, loadSession, resetData, toast, toastError, useStore } from '../store';
import { DidEditor } from './DidEditor';
import { Switch } from './ui';
import type { ConnectionTestDto } from '../../../shared/types';

const IMPORT_CHOICES = [30, 90, 365, 730];

export function Settings() {
  useLang();
  const session = useStore((s) => s.session);
  const dids = useStore((s) => s.dids);
  const sync = useStore((s) => s.sync);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [notify, setNotify] = useState(notificationsEnabled());
  const [sound, setSound] = useState(soundEnabled());
  const [push, setPush] = useState(pushEnabledHere());
  const [pushBusy, setPushBusy] = useState(false);
  const support = pushSupport();
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState<ConnectionTestDto | null>(null);
  const [importDays, setImportDays] = useState(90);
  const langChoice = prefs.get('lang') ?? 'auto';

  const refreshDids = async () => {
    setRefreshing(true);
    try {
      await api.refreshDids();
      await loadDids();
    } catch (err) {
      toastError(err);
    } finally {
      setRefreshing(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      setConnection(await api.testConnection());
    } catch (err) {
      setConnection({ ip: null, status: err instanceof ApiError ? err.code : 'offline', balance: null });
    } finally {
      setTesting(false);
    }
  };

  const toggleNotify = async (on: boolean) => {
    if (on) {
      const granted = await enableNotifications();
      if (!granted) toast(t('settings.notifBlocked'), 'error');
      setNotify(granted);
    } else {
      disableNotifications();
      setNotify(false);
    }
  };

  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    try {
      if (on) {
        const result = await enablePush();
        if (result === 'denied') toast(t('settings.notifBlocked'), 'error');
        setPush(result === 'ok');
      } else {
        await disablePush();
        setPush(false);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setPushBusy(false);
    }
  };

  const testPush = async () => {
    try {
      await sendTestPush();
      toast(t('settings.pushTestSent'));
    } catch (err) {
      toastError(err instanceof ApiError ? err : new ApiError(0, 'not_subscribed'));
    }
  };

  const pushHint =
    support === 'insecure'
      ? t('settings.pushInsecure')
      : support === 'ios-install'
        ? t('settings.pushIos')
        : support === 'unsupported'
          ? t('settings.pushUnsupported')
          : Notification.permission === 'denied'
            ? t('settings.notifBlocked')
            : t('settings.pushHint');

  const logout = async () => {
    // Notifications show message previews: a signed-out device stops receiving them.
    await disablePush().catch(() => undefined);
    await api.logout().catch(() => undefined);
    resetData();
    await loadSession();
    navigate({ name: 'home' }, { replace: true });
  };

  const startImport = async () => {
    try {
      await api.importHistory(importDays);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <header className="page-header">
        <button className="icon-btn mobile-only" aria-label={t('common.back')} onClick={() => navigate({ name: 'home' })}>
          <ArrowLeft size={22} />
        </button>
        <h2>{t('settings.title')}</h2>
      </header>
      <div className="page">
        <div className="page-inner">
          {session?.demo && <div className="banner info" style={{ margin: 0 }}>{t('settings.demo')}</div>}

          <section className="section">
            <h3>{t('settings.numbers')}</h3>
            <p>{t('settings.numbersHint')}</p>
            <div className="card">
              {dids.map((d) => (
                <DidEditor key={d.did} did={d} onChange={() => void loadDids()} />
              ))}
            </div>
            <button className="btn text" style={{ marginTop: 8 }} onClick={refreshDids} disabled={refreshing}>
              <RefreshCw size={18} className={refreshing ? 'spin' : ''} />
              {t('settings.refreshNumbers')}
            </button>
          </section>

          <section className="section">
            <h3>{t('settings.notifications')}</h3>
            <div className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{t('settings.push')}</div>
                  <div className="row-sub">{pushHint}</div>
                  {push && (
                    <button className="btn text small" style={{ marginTop: 4, marginLeft: -12 }} onClick={() => void testPush()}>
                      {t('settings.pushTest')}
                    </button>
                  )}
                </div>
                {support === 'ok' && (
                  <Switch
                    checked={push}
                    label={t('settings.push')}
                    onChange={(v) => {
                      if (!pushBusy) void togglePush(v);
                    }}
                  />
                )}
              </div>
              {notificationsSupported() && (
                <div className="row">
                  <div className="row-main">
                    <div className="row-title">{t('settings.desktopNotif')}</div>
                    <div className="row-sub">
                      {Notification.permission === 'denied' ? t('settings.notifBlocked') : t('settings.desktopNotifHint')}
                    </div>
                  </div>
                  <Switch checked={notify} label={t('settings.desktopNotif')} onChange={(v) => void toggleNotify(v)} />
                </div>
              )}
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{t('settings.sound')}</div>
                </div>
                <Switch
                  checked={sound}
                  label={t('settings.sound')}
                  onChange={(v) => {
                    prefs.set('sound', v ? 'on' : 'off');
                    setSound(v);
                  }}
                />
              </div>
            </div>
          </section>

          <section className="section">
            <h3>{t('settings.appearance')}</h3>
            <div className="card">
              <div className="row">
                <div className="row-main row-title">{t('settings.theme')}</div>
                <div className="segmented">
                  {(['system', 'light', 'dark'] as Theme[]).map((value) => (
                    <button
                      key={value}
                      aria-pressed={theme === value}
                      onClick={() => {
                        applyTheme(value);
                        setThemeState(value);
                      }}
                    >
                      {t(value === 'system' ? 'settings.themeSystem' : value === 'light' ? 'settings.themeLight' : 'settings.themeDark')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="row">
                <div className="row-main row-title">{t('settings.language')}</div>
                <div className="segmented">
                  {(['auto', 'fr', 'en'] as const).map((value) => (
                    <button key={value} aria-pressed={langChoice === value} onClick={() => {
                      setLang(value);
                      // Notifications are written on the server, in the language of each device.
                      void refreshPush().catch(() => undefined);
                    }}>
                      {value === 'auto' ? t('settings.languageAuto') : value === 'fr' ? 'Français' : 'English'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="section">
            <h3>{t('settings.account')}</h3>
            <div className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{t('settings.username')}</div>
                  <div className="row-sub">
                    {session?.credentialsSource === 'env' ? t('settings.credentialsEnv') : t('settings.credentialsDb')}
                  </div>
                </div>
                <button className="btn tonal small" onClick={test} disabled={testing}>
                  {testing && <Loader2 size={16} className="spin" />}
                  {t('settings.testConnection')}
                </button>
              </div>
              {connection && (
                <div className="row">
                  <div className="row-main">
                    {connection.status === 'success' ? (
                      <span className="ok-text">✓ {t('setup.ip.ok', { balance: connection.balance?.toFixed(2) ?? '—' })}</span>
                    ) : (
                      <span className="error-text">{errorText(connection.status)}</span>
                    )}
                    {connection.ip && (
                      <div className="row-sub">
                        {t('setup.ip.yourIp')} : <code>{connection.ip}</code>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {!session?.demo && (
                <div className="row">
                  <div className="row-main row-sub">{t('settings.runWizard')}</div>
                  <button className="btn outlined small" onClick={() => navigate({ name: 'setup' })}>
                    {session?.credentialsSource === 'env' ? t('settings.runWizard') : t('settings.changeCredentials')}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="section">
            <h3>{t('settings.sync')}</h3>
            <p>{t('settings.syncMode', { active: session?.pollActiveSeconds ?? 10, idle: session?.pollIdleSeconds ?? 60 })}</p>
            <div className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{t('settings.lastSync')}</div>
                  <div className="row-sub">
                    {sync?.lastSyncAt
                      ? new Intl.DateTimeFormat(getLang() === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(sync.lastSyncAt)
                      : t('settings.never')}
                    {sync?.state === 'error' && sync.lastError && <span className="error-text"> · {errorText(sync.lastError)}</span>}
                  </div>
                </div>
                <button className="btn tonal small" onClick={() => void api.syncNow().catch(toastError)}>
                  <RefreshCw size={16} className={sync?.state === 'syncing' ? 'spin' : ''} />
                  {t('settings.syncNow')}
                </button>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{t('settings.importHistory')}</div>
                  {sync?.importing && <div className="row-sub">{t('sync.importing', sync.importing)}</div>}
                </div>
                <div className="row-actions">
                  <select className="input" style={{ width: 'auto', height: 36 }} value={importDays} onChange={(e) => setImportDays(Number(e.target.value))}>
                    {IMPORT_CHOICES.map((d) => (
                      <option key={d} value={d}>
                        {d === 365 ? t('setup.history.year') : t('setup.history.days', { n: d })}
                      </option>
                    ))}
                  </select>
                  <button className="btn tonal small" onClick={startImport} disabled={!!sync?.importing}>
                    {t('settings.history')}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="section" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn outlined" onClick={logout}>
              <LogOut size={18} />
              {t('settings.logout')}
            </button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>
              {t('settings.version', { version: session?.version ?? '' })}
            </span>
          </section>
        </div>
      </div>
    </>
  );
}
