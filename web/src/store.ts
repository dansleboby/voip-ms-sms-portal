import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { errorText, t } from './i18n';
import { notifyIncoming } from './lib/notify';
import { deviceId, tabId } from './lib/push';
import { prefs } from './lib/prefs';
import type {
  ContactDto,
  ConversationDto,
  DidDto,
  MessageDto,
  ServerEvent,
  SessionDto,
  SyncStatusDto,
} from '../../shared/types';

export interface ThreadState {
  items: MessageDto[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
  action?: { label: string; run: () => void };
}

export interface State {
  session: SessionDto | null;
  dids: DidDto[];
  contacts: ContactDto[];
  /** Main list: conversations that are not archived. */
  conversations: ConversationDto[];
  conversationsLoaded: boolean;
  /** Loaded the first time the archive is opened. */
  archived: ConversationDto[];
  archivedLoaded: boolean;
  /** Every conversation seen so far, archived or not, by id. */
  known: Record<number, ConversationDto>;
  threads: Record<number, ThreadState>;
  sync: SyncStatusDto | null;
  /** Number selected in the side rail; null shows every number. */
  didFilter: string | null;
  /** The sidebar lists archived conversations instead of the main list. */
  archiveView: boolean;
  /** Conversation on screen, to skip notifications and mark it read. */
  activeConversationId: number | null;
  connected: boolean;
  /** The server now runs another version than the one this page was loaded with. */
  updateAvailable: boolean;
  toasts: Toast[];
}

let state: State = {
  session: null,
  dids: [],
  contacts: [],
  conversations: [],
  conversationsLoaded: false,
  archived: [],
  archivedLoaded: false,
  known: {},
  threads: {},
  sync: null,
  didFilter: prefs.get('did'),
  archiveView: false,
  activeConversationId: null,
  connected: true,
  updateAvailable: false,
  toasts: [],
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

/** Selectors must return stored references (derive new arrays with useMemo). */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

// ------------------------------------------------------------------- toasts

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
  setTimeout(() => dismissToast(id), kind === 'error' || action ? 7000 : 4000);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function toastError(err: unknown): void {
  toast(err instanceof ApiError ? errorText(err.code) : t('error.internal_error'), 'error');
}

// ------------------------------------------------------------------ loading

/** Version of the server this page was loaded from. */
let pageVersion: string | null = null;

export async function loadSession(): Promise<SessionDto> {
  const session = await api.session();
  pageVersion ??= session.version;
  setState({ session, updateAvailable: session.version !== pageVersion });
  return session;
}

export async function loadDids(): Promise<void> {
  const dids = await api.dids();
  setState((s) => ({
    dids,
    didFilter: s.didFilter && dids.some((d) => d.did === s.didFilter && d.visible) ? s.didFilter : null,
  }));
}

export async function loadContacts(): Promise<void> {
  setState({ contacts: await api.contacts() });
}

function remember(known: Record<number, ConversationDto>, list: ConversationDto[]): Record<number, ConversationDto> {
  const next = { ...known };
  for (const c of list) next[c.id] = c;
  return next;
}

export async function loadConversations(): Promise<void> {
  const conversations = await api.conversations();
  setState((s) => ({ conversations, conversationsLoaded: true, known: remember(s.known, conversations) }));
}

export async function loadArchived(): Promise<void> {
  const archived = await api.conversations({ archived: true });
  setState((s) => ({ archived, archivedLoaded: true, known: remember(s.known, archived) }));
}

export async function loadAll(): Promise<void> {
  await Promise.all([loadDids(), loadContacts(), loadConversations(), api.syncStatus().then((sync) => setState({ sync }))]);
}

function debounce(fn: () => Promise<void>, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn().catch(() => undefined);
    }, ms);
  };
}

const reloadConversations = debounce(async () => {
  await Promise.all([loadConversations(), state.archivedLoaded ? loadArchived() : undefined]);
}, 300);
/** After bulk changes (history import): refresh the open thread, forget the others. */
const reloadThreads = debounce(async () => {
  const active = state.activeConversationId;
  setState((s) => ({ threads: active !== null && s.threads[active] ? { [active]: s.threads[active]! } : {} }));
  if (active !== null) await loadThread(active, { replace: true });
}, 500);
const reloadDids = debounce(loadDids, 300);
const reloadContacts = debounce(loadContacts, 300);

export function setDidFilter(did: string | null): void {
  prefs.set('did', did);
  setState({ didFilter: did });
}

export function setArchiveView(on: boolean): void {
  if (state.archiveView !== on) setState({ archiveView: on });
  if (on && !state.archivedLoaded) loadArchived().catch(toastError);
}

export function setActiveConversation(id: number | null): void {
  if (state.activeConversationId !== id) setState({ activeConversationId: id });
}

// ------------------------------------------------------------------ threads

const EMPTY_THREAD: ThreadState = { items: [], hasMore: false, loading: false, loaded: false };

export function threadOf(s: State, id: number): ThreadState {
  return s.threads[id] ?? EMPTY_THREAD;
}

function patchThread(id: number, patch: Partial<ThreadState>): void {
  setState((s) => ({ threads: { ...s.threads, [id]: { ...threadOf(s, id), ...patch } } }));
}

/**
 * Loads the newest page of a conversation. When it does not overlap what is
 * already shown (many messages arrived while offline, or history was
 * imported), it replaces it so no gap is left; older pages load on scroll.
 */
export async function loadThread(id: number, options: { replace?: boolean } = {}): Promise<void> {
  const current = threadOf(state, id);
  if (current.loading) return;
  patchThread(id, { loading: true });
  try {
    const items = await api.messages(id);
    const existing = threadOf(state, id).items;
    const known = new Set(existing.map((m) => m.id));
    const replace = options.replace || existing.length === 0 || !items.some((m) => known.has(m.id));
    patchThread(id, {
      items: replace ? items : mergeMessages(existing, items),
      hasMore: replace ? items.length >= 50 : threadOf(state, id).hasMore,
      loaded: true,
    });
  } finally {
    patchThread(id, { loading: false });
  }
}

export async function loadOlder(id: number): Promise<void> {
  const current = threadOf(state, id);
  if (current.loading || !current.hasMore || current.items.length === 0) return;
  patchThread(id, { loading: true });
  try {
    const items = await api.messages(id, current.items[0]!.id);
    patchThread(id, { items: mergeMessages(threadOf(state, id).items, items), hasMore: items.length >= 50 });
  } finally {
    patchThread(id, { loading: false });
  }
}

function mergeMessages(existing: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);
}

const byRecent = (a: ConversationDto, b: ConversationDto) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || b.id - a.id;

/** Puts a conversation in the main list or the archive, wherever its state says it belongs. */
function upsertConversation(conversation: ConversationDto): void {
  setState((s) => {
    const known = { ...s.known, [conversation.id]: conversation };
    const did = s.dids.find((d) => d.did === conversation.did);
    const shown = !!conversation.lastMessage && !(did && !did.visible);
    const conversations = s.conversations.filter((c) => c.id !== conversation.id);
    if (shown && !conversation.archived) conversations.push(conversation);
    conversations.sort(byRecent);
    const archived = s.archived.filter((c) => c.id !== conversation.id);
    if (shown && conversation.archived && s.archivedLoaded) archived.push(conversation);
    archived.sort(byRecent);
    return { conversations, archived, known };
  });
}

function upsertMessage(message: MessageDto): boolean {
  const thread = state.threads[message.conversationId];
  const isNew = !thread?.items.some((m) => m.id === message.id);
  if (thread?.loaded) patchThread(message.conversationId, { items: mergeMessages(thread.items, [message]) });
  return isNew;
}

export async function markRead(conversationId: number): Promise<void> {
  const conversation = state.known[conversationId];
  if (!conversation || conversation.unreadCount === 0) return;
  upsertConversation({ ...conversation, unreadCount: 0 });
  await api.markRead(conversationId).catch(() => undefined);
}

export async function setArchived(conversationId: number, archived: boolean): Promise<void> {
  upsertConversation(await api.updateConversation(conversationId, { archived }));
}

/** Makes a conversation opened by link (not in any loaded list) available to the views. */
export async function fetchConversation(id: number): Promise<ConversationDto> {
  const conversation = await api.conversation(id);
  setState((s) => ({ known: { ...s.known, [id]: conversation } }));
  return conversation;
}

// ------------------------------------------------------------------ sending

export async function sendMessage(input: { did: string; to: string; body: string; files: File[] }): Promise<ConversationDto> {
  const { message, conversation } = await api.send(input);
  // The message is on its way: a failure to refresh the thread must not look like a failed send.
  if (!state.threads[conversation.id]?.loaded) await loadThread(conversation.id).catch(() => undefined);
  upsertMessage(message);
  upsertConversation(conversation);
  return conversation;
}

export async function retryMedia(id: number): Promise<void> {
  await api.retryMedia(id).catch(toastError);
}

export async function retryMessage(id: number): Promise<void> {
  try {
    upsertMessage(await api.retry(id));
  } catch (err) {
    toastError(err);
  }
}

// ------------------------------------------------------------------- events

let source: EventSource | null = null;
const notified = new Set<number>();

function handleEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'message': {
      const isNew = upsertMessage(event.message);
      upsertConversation(event.conversation);
      const m = event.message;
      if (m.direction === 'in' && isNew && !notified.has(m.id)) {
        notified.add(m.id);
        const viewing = state.activeConversationId === m.conversationId && document.visibilityState === 'visible';
        if (!viewing) notifyIncoming(m, event.conversation, state.dids);
      }
      break;
    }
    case 'conversation':
      upsertConversation(event.conversation);
      break;
    case 'reload':
      reloadConversations();
      reloadThreads();
      break;
    case 'dids':
      reloadDids();
      break;
    case 'contacts':
      reloadContacts();
      break;
    case 'sync':
      setState({ sync: event.status });
      break;
  }
}

const visible = () => document.visibilityState === 'visible';
const reportVisibility = () => void api.presence(tabId, visible());

export function connectEvents(): void {
  if (source) return;
  const params = new URLSearchParams({ device: deviceId(), tab: tabId, visible: visible() ? '1' : '0' });
  source = new EventSource(`/api/events?${params}`);
  document.addEventListener('visibilitychange', reportVisibility);
  source.onopen = () => {
    const wasDisconnected = !state.connected;
    setState({ connected: true });
    // The URL's visibility may be stale after an automatic reconnection.
    reportVisibility();
    // Catch up on whatever happened while disconnected (the server may also have been updated).
    if (wasDisconnected) {
      void loadSession().catch(() => undefined);
      reloadConversations();
      reloadDids();
      for (const id of Object.keys(state.threads)) void loadThread(Number(id));
    }
  };
  source.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data as string) as ServerEvent);
    } catch {
      // Ignore malformed frames.
    }
  };
  source.onerror = () => {
    setState({ connected: false });
    // EventSource hides the status code: check whether the session expired.
    loadSession()
      .then((session) => {
        if (!session.authenticated) disconnectEvents();
      })
      .catch(() => undefined);
  };
}

export function disconnectEvents(): void {
  document.removeEventListener('visibilitychange', reportVisibility);
  source?.close();
  source = null;
}

export function resetData(): void {
  disconnectEvents();
  setState({
    conversations: [],
    conversationsLoaded: false,
    archived: [],
    archivedLoaded: false,
    known: {},
    threads: {},
    contacts: [],
    dids: [],
    sync: null,
  });
}
