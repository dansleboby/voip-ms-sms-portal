import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BookUser,
  CloudOff,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { api } from '../api';
import { errorText, t } from '../i18n';
import { didName, displayName, formatListDate } from '../lib/format';
import { navigate, type Route } from '../lib/router';
import { setArchiveView, setDidFilter, toastError, useStore } from '../store';
import { Contacts } from './Contacts';
import { NewConversation } from './NewConversation';
import { Settings } from './Settings';
import { Thread } from './Thread';
import { Avatar, Logo, Toasts } from './ui';
import { formatPhone } from '../../../shared/phone';
import type { ConversationDto, DidDto } from '../../../shared/types';

/** Number shown in the rail: the label's first letter, or the area code. */
function didMark(did: DidDto): string {
  return did.label ? [...did.label][0]!.toUpperCase() : did.did.slice(0, 3);
}

export function Shell({ route }: { route: Route }) {
  const dids = useStore((s) => s.dids);
  const conversations = useStore((s) => s.conversations);
  const visibleDids = useMemo(() => dids.filter((d) => d.visible), [dids]);
  const totalUnread = useMemo(() => conversations.reduce((n, c) => n + c.unreadCount, 0), [conversations]);

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${t('app.name')}` : t('app.name');
  }, [totalUnread]);

  // The archive stays in the sidebar while one of its conversations is open.
  const archiveView = useStore((s) => s.archiveView);
  useEffect(() => {
    if (route.name === 'archived') setArchiveView(true);
    else if (route.name !== 'conversation') setArchiveView(false);
  }, [route.name]);

  const showMain = route.name !== 'home' && route.name !== 'archived';
  let main;
  switch (route.name) {
    case 'conversation':
      main = <Thread key={route.id} id={route.id} />;
      break;
    case 'new':
      main = <NewConversation initialPhone={route.phone} />;
      break;
    case 'contacts':
      main = <Contacts />;
      break;
    case 'settings':
      main = <Settings />;
      break;
    case 'archived':
      main = (
        <div className="placeholder-pane">
          <Archive size={56} strokeWidth={1.2} />
          <h2>{t('nav.archived')}</h2>
          <p>{t('list.archivedHint')}</p>
        </div>
      );
      break;
    default:
      main = (
        <div className="placeholder-pane">
          <MessageSquareText size={56} strokeWidth={1.2} />
          <h2>{t('thread.select')}</h2>
          <p>{t('thread.selectHint')}</p>
        </div>
      );
  }

  return (
    <div className={`app${showMain ? ' show-main' : ''}`}>
      <Rail route={route} dids={visibleDids} />
      {archiveView ? (
        <ArchiveSidebar key="archive" route={route} dids={visibleDids} />
      ) : (
        <Sidebar key="inbox" route={route} dids={visibleDids} />
      )}
      <section className="main">{main}</section>
      <Toasts />
    </div>
  );
}

function Rail({ route, dids }: { route: Route; dids: DidDto[] }) {
  const didFilter = useStore((s) => s.didFilter);
  const archiveView = useStore((s) => s.archiveView);
  const allUnread = dids.reduce((n, d) => n + d.unreadCount, 0);
  const onMessages = !archiveView && (route.name === 'home' || route.name === 'conversation' || route.name === 'new');

  const select = (did: string | null) => {
    setDidFilter(did);
    if (!onMessages) navigate({ name: 'home' });
  };

  return (
    <nav className="rail" aria-label="Navigation">
      <div className="rail-logo">
        <Logo size={36} />
      </div>
      <button className="rail-item" aria-current={onMessages && didFilter === null} onClick={() => select(null)} title={t('nav.all')}>
        <span className="rail-icon">
          <MessageSquareText size={22} />
          {allUnread > 0 && <span className="badge">{allUnread > 99 ? '99+' : allUnread}</span>}
        </span>
        <span className="rail-label">{dids.length > 1 ? t('nav.allShort') : t('nav.messages')}</span>
      </button>
      {dids.length > 1 &&
        dids.map((d) => (
          <button
            key={d.did}
            className="rail-item"
            aria-current={onMessages && didFilter === d.did}
            onClick={() => select(d.did)}
            title={`${didName(d, d.did)} · ${formatPhone(d.did)}`}
          >
            <span className="rail-icon">
              <span className={`rail-did${d.label ? '' : ' digits'}`} style={{ background: d.color }}>
                {didMark(d)}
              </span>
              {d.unreadCount > 0 && <span className="badge">{d.unreadCount > 99 ? '99+' : d.unreadCount}</span>}
            </span>
            <span className="rail-label">{d.label || formatPhone(d.did).slice(0, 5)}</span>
          </button>
        ))}
      <div className="rail-spacer" />
      <button className="rail-item" aria-current={route.name === 'contacts'} onClick={() => navigate({ name: 'contacts' })}>
        <span className="rail-icon">
          <BookUser size={22} />
        </span>
        <span className="rail-label">{t('nav.contacts')}</span>
      </button>
      <button className="rail-item" aria-current={route.name === 'settings'} onClick={() => navigate({ name: 'settings' })}>
        <span className="rail-icon">
          <SettingsIcon size={22} />
        </span>
        <span className="rail-label">{t('nav.settings')}</span>
      </button>
    </nav>
  );
}

function Sidebar({ route, dids }: { route: Route; dids: DidDto[] }) {
  const all = useStore((s) => s.conversations);
  const loaded = useStore((s) => s.conversationsLoaded);
  const didFilter = useStore((s) => s.didFilter);
  const session = useStore((s) => s.session);
  const [query, setQuery] = useState('');

  const results = useSearch(query);

  const list = useMemo(() => {
    const source = results ?? all;
    return didFilter ? source.filter((c) => c.did === didFilter) : source;
  }, [results, all, didFilter]);

  const didByNumber = useMemo(() => new Map(dids.map((d) => [d.did, d])), [dids]);
  const activeId = route.name === 'conversation' ? route.id : null;
  const multi = dids.length > 1;
  const filtered = didFilter ? didByNumber.get(didFilter) : undefined;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <span className="mobile-only">
            <Logo size={32} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{filtered ? didName(filtered, filtered.did) : t('app.name')}</h1>
            {filtered && <div className="tagline">{formatPhone(filtered.did)}</div>}
          </div>
          <button className="icon-btn" aria-label={t('nav.archived')} title={t('nav.archived')} onClick={() => navigate({ name: 'archived' })}>
            <Archive size={22} />
          </button>
          <button className="icon-btn mobile-only" aria-label={t('nav.contacts')} onClick={() => navigate({ name: 'contacts' })}>
            <BookUser size={22} />
          </button>
          <button className="icon-btn mobile-only" aria-label={t('nav.settings')} onClick={() => navigate({ name: 'settings' })}>
            <SettingsIcon size={22} />
          </button>
        </div>
        <button className="btn new-chat" onClick={() => navigate({ name: 'new' })}>
          <Pencil size={20} />
          {t('nav.newChat')}
        </button>
        <SearchBox query={query} onChange={setQuery} placeholder={t('list.searchPlaceholder')} />
        {multi && (
          <div className="filter-chips mobile-only" role="group">
            <button className="filter-chip" aria-pressed={didFilter === null} onClick={() => setDidFilter(null)}>
              {t('nav.allShort')}
            </button>
            {dids.map((d) => (
              <button key={d.did} className="filter-chip" aria-pressed={didFilter === d.did} onClick={() => setDidFilter(d.did)}>
                <span className="did-dot" style={{ background: d.color }} />
                {didName(d, d.did)}
                {d.unreadCount > 0 && ` · ${d.unreadCount}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {session?.demo && <div className="banner info">{t('settings.demo')}</div>}
      <StatusBanners />

      <div className="conv-list" role="list">
        {list.map((c) => (
          <ConversationItem
            key={c.id}
            conversation={c}
            did={multi && !didFilter ? didByNumber.get(c.did) : undefined}
            active={c.id === activeId}
            archived={c.archived}
          />
        ))}
        {loaded && list.length === 0 && (
          <div className="list-empty">{results ? t('list.emptySearch', { q: query.trim() }) : t('list.empty')}</div>
        )}
      </div>
    </aside>
  );
}

/** Same sidebar, listing archived conversations (all numbers). */
function ArchiveSidebar({ route, dids }: { route: Route; dids: DidDto[] }) {
  const all = useStore((s) => s.archived);
  const loaded = useStore((s) => s.archivedLoaded);
  const [query, setQuery] = useState('');
  const results = useSearch(query, true);
  const list = results ?? all;
  const didByNumber = useMemo(() => new Map(dids.map((d) => [d.did, d])), [dids]);
  const activeId = route.name === 'conversation' ? route.id : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <button className="icon-btn" aria-label={t('common.back')} onClick={() => navigate({ name: 'home' })}>
            <ArrowLeft size={22} />
          </button>
          <h1 style={{ flex: 1, minWidth: 0 }}>{t('list.archivedTitle')}</h1>
        </div>
        <SearchBox query={query} onChange={setQuery} placeholder={t('list.searchArchived')} />
      </div>
      <StatusBanners />
      <div className="conv-list" role="list">
        {list.map((c) => (
          <ConversationItem
            key={c.id}
            conversation={c}
            did={dids.length > 1 ? didByNumber.get(c.did) : undefined}
            active={c.id === activeId}
          />
        ))}
        {loaded && list.length === 0 && (
          <div className="list-empty">
            {results ? t('list.emptySearch', { q: query.trim() }) : t('list.archivedEmpty')}
            {!results && (
              <>
                <br />
                <small>{t('list.archivedHint')}</small>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Server-side search, debounced; null while the box is empty. */
function useSearch(query: string, archived?: boolean): ConversationDto[] | null {
  const [results, setResults] = useState<ConversationDto[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api.conversations({ q, archived }).then(setResults).catch(toastError);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, archived]);
  return results;
}

function SearchBox({ query, onChange, placeholder }: { query: string; onChange: (q: string) => void; placeholder: string }) {
  return (
    <label className="search">
      <Search size={20} />
      <input type="search" placeholder={placeholder} aria-label={t('common.search')} value={query} onChange={(e) => onChange(e.target.value)} />
      {query && (
        <button className="icon-btn" aria-label={t('common.close')} onClick={() => onChange('')}>
          <X size={18} />
        </button>
      )}
    </label>
  );
}

function StatusBanners() {
  const sync = useStore((s) => s.sync);
  const connected = useStore((s) => s.connected);
  const updateAvailable = useStore((s) => s.updateAvailable);
  return (
    <>
      {updateAvailable && (
        <div className="banner info">
          <RefreshCw size={18} />
          <span style={{ flex: 1 }}>{t('app.updated')}</span>
          <button className="btn text small" onClick={() => location.reload()}>
            {t('app.reload')}
          </button>
        </div>
      )}
      {!connected && (
        <div className="banner warning">
          <CloudOff size={18} />
          {t('error.offline')}
        </div>
      )}
      {sync?.state === 'error' && sync.lastError && (
        <div className="banner error">
          <AlertCircle size={18} />
          {t('sync.error', { error: errorText(sync.lastError) })}
        </div>
      )}
      {sync?.importing && (
        <div className="banner info" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {t('sync.importing', sync.importing)}
          <div className="progress">
            <div style={{ width: `${(sync.importing.done / Math.max(sync.importing.total, 1)) * 100}%` }} />
          </div>
        </div>
      )}
    </>
  );
}

function ConversationItem({
  conversation: c,
  did,
  active,
  archived,
}: {
  conversation: ConversationDto;
  did?: DidDto;
  active: boolean;
  /** Flags an archived conversation among search results. */
  archived?: boolean;
}) {
  const name = displayName(c.phone, c.contact);
  const last = c.lastMessage;
  let snippet = last?.body ?? '';
  if (last && !snippet && last.attachmentCount > 0) {
    snippet = last.attachmentCount > 1 ? t('list.photos', { n: last.attachmentCount }) : `📎 ${t('list.photo')}`;
  }
  const unread = c.unreadCount > 0;
  return (
    <button
      role="listitem"
      className={`conv-item${unread ? ' unread' : ''}`}
      aria-current={active}
      onClick={() => navigate({ name: 'conversation', id: c.id })}
    >
      <Avatar name={name} seed={c.phone} />
      <div className="conv-body">
        <div className="conv-row">
          <span className="conv-name">{name}</span>
          {c.lastMessageAt && <span className="conv-time">{formatListDate(c.lastMessageAt)}</span>}
        </div>
        <div className="conv-row">
          <span className="conv-snippet">
            {last?.status === 'failed' ? (
              <span className="failed">{t('list.failed')} · </span>
            ) : (
              last?.direction === 'out' && t('list.you')
            )}
            {snippet}
          </span>
          {unread && <span className="unread-dot" aria-label={String(c.unreadCount)} />}
        </div>
        {(did || archived) && (
          <div className="conv-chips">
            {did && (
              <span className="did-chip" style={{ ['--chip-color' as string]: did.color }}>
                <span className="did-dot" style={{ background: did.color }} />
                {didName(did, did.did)}
              </span>
            )}
            {archived && (
              <span className="did-chip" style={{ ['--chip-color' as string]: 'var(--outline)' }}>
                <Archive size={12} />
                {t('list.archivedChip')}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
