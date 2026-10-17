import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { errorText, t } from '../i18n';
import { toast, toastError } from '../store';
import { Ago, Dialog } from './ui';
import type { UpdateStatusDto } from '../../../shared/types';

/** The commands that update the other kinds of install. */
const COMMANDS = {
  docker: 'docker compose pull && docker compose up -d',
  source: 'git pull && npm ci && npm run build',
} as const;

/** **bold**, *italic*, `code` and [links](https://...) of a changelog line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    if (/^\*\*.+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`.+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*.+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={i}>{part.replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1')}</Fragment>;
  });
}

/** The release's changelog section: a list of bullets, as written in CHANGELOG.md. */
function ReleaseNotes({ notes }: { notes: string }) {
  const items = notes
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
  return (
    <ul className="release-notes">
      {items.map((item, i) => (
        <li key={i}>{inline(item)}</li>
      ))}
    </ul>
  );
}

/** Settings > Updates: the newest release, and how to get it on this server. */
export function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);

  const load = async (refresh = false) => {
    setChecking(true);
    try {
      setStatus(await api.updateStatus(refresh));
    } catch (err) {
      if (refresh) toastError(err);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const install = async () => {
    setConfirming(false);
    setInstalling(true);
    try {
      const { version } = await api.installUpdate();
      toast(t('updates.installed', { version }));
      // The page and the server must run the same version.
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      toastError(err);
      setInstalling(false);
      void load();
    }
  };

  if (!status) return null;
  const latest = status.available ? status.latest : null;

  return (
    <section className="section">
      <h3>{t('updates.title')}</h3>
      <div className="card">
        <div className="row">
          <div className="row-main">
            <div className="row-title">
              {!status.enabled ? t('updates.off') : latest ? t('updates.available', { version: latest.version }) : t('updates.upToDate')}
            </div>
            <div className="row-sub">
              {t('updates.current', { version: status.current })}
              {status.enabled && status.checkedAt && (
                <>
                  {' · '}
                  {t('updates.checked')} <Ago at={status.checkedAt} />
                </>
              )}
              {status.error && <span className="error-text"> · {errorText(status.error)}</span>}
            </div>
          </div>
          {status.enabled && (
            <button className="btn tonal small" onClick={() => void load(true)} disabled={checking || installing}>
              <RefreshCw size={16} className={checking ? 'spin' : ''} />
              {t('updates.check')}
            </button>
          )}
        </div>
        {latest && (
          <div className="row update-details">
            <ReleaseNotes notes={latest.notes} />
            <a className="btn text small" href={latest.url} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              {t('updates.details')}
            </a>
            {status.install === 'php' ? (
              status.canInstall ? (
                <button className="btn" onClick={() => setConfirming(true)} disabled={installing}>
                  {installing ? <Loader2 size={18} className="spin" /> : <Download size={18} />}
                  {installing ? t('updates.installing') : t('updates.install', { version: latest.version })}
                </button>
              ) : (
                <div>
                  <div className="error-text">{errorText(status.blocked ?? 'install_failed')}</div>
                  {status.paths && <code className="command">{status.paths.join('\n')}</code>}
                </div>
              )
            ) : (
              <div>
                <div className="row-sub">{t(status.install === 'docker' ? 'updates.docker' : 'updates.source')}</div>
                <code className="command">{COMMANDS[status.install]}</code>
              </div>
            )}
          </div>
        )}
      </div>
      {confirming && latest && (
        <Dialog title={t('updates.confirmTitle', { version: latest.version })} onClose={() => setConfirming(false)}>
          <p>{t('updates.confirmBody')}</p>
          <div className="dialog-actions">
            <button type="button" className="btn text" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn" onClick={() => void install()}>
              {t('updates.install', { version: latest.version })}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
