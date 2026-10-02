import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { errorText, t } from './i18n';
import { notifyIncoming } from './lib/notify';
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
}

export interface State {
  session: SessionDto | null;
  dids: DidDto[];
  contacts: ContactDto[];
  conversations: ConversationDto[];
  conversationsLoaded: boolean;
  threads: Record<number, ThreadState>;
  sync: SyncStatusDto | null;
  /** Number selected in the side rail; null shows every number. */
  didFilter: string | null;
  /** Conversation on screen, to skip notifications and mark it read. */
  activeConversationId: number | null;
  connected: boolean;
  toasts: Toast[];
}

let state: State = {
  session: null,
  dids: [],
  contacts: [],
  conversations: [],
  conversationsLoaded: false,
  threads: {},
  sync: null,
  didFilter: prefs.get('did'),
  activeConversationId: null,
  connected: true,
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
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4000);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function toastError(err: unknown): void {
  toast(err instanceof ApiError ? errorText(err.code) : t('error.internal_error'), 'error');
}

// ------------------------------------------------------------------ loading

export async function loadSession(): Promise<SessionDto> {
  const session = await api.session();
  setState({ session });
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

export async function loadConversations(): Promise<void> {
  const conversations = await api.conversations();
  setState({ conversations, conversationsLoaded: true });
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

const reloadConversations = debounce(loadConversations, 300);
const reloadDids = debounce(loadDids, 300);
const reloadContacts = debounce(loadContacts, 300);

export function setDidFilter(did: string | null): void {
  prefs.set('did', did);
  setState({ didFilter: did });
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

export async function loadThread(id: number): Promise<void> {
  const current = threadOf(state, id);
  if (current.loading) return;
  patchThread(id, { loading: true });
  try {
    const items = await api.messages(id);
    patchThread(id, { items: mergeMessages(threadOf(state, id).items, items), hasMore: items.length >= 50, loaded: true });
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

function upsertConversation(conversation: ConversationDto): void {
  const did = state.dids.find((d) => d.did === conversation.did);
  if (did && !did.visible) return;
  setState((s) => {
    const others = s.conversations.filter((c) => c.id !== conversation.id);
    const list = conversation.lastMessage ? [conversation, ...others] : others;
    list.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || b.id - a.id);
    return { conversations: list };
  });
}

function upsertMessage(message: MessageDto): boolean {
  const thread = state.threads[message.conversationId];
  const isNew = !thread?.items.some((m) => m.id === message.id);
  if (thread?.loaded) patchThread(message.conversationId, { items: mergeMessages(thread.items, [message]) });
  return isNew;
}

export async function markRead(conversationId: number): Promise<void> {
  const conversation = state.conversations.find((c) => c.id === conversationId);
  if (!conversation || conversation.unreadCount === 0) return;
  upsertConversation({ ...conversation, unreadCount: 0 });
  await api.markRead(conversationId).catch(() => undefined);
}

// ------------------------------------------------------------------ sending

export async function sendMessage(input: { did: string; to: string; body: string; files: File[] }): Promise<ConversationDto> {
  const { message, conversation } = await api.send(input);
  if (!state.threads[conversation.id]?.loaded) await loadThread(conversation.id);
  upsertMessage(message);
  upsertConversation(conversation);
  return conversation;
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

export function connectEvents(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => {
    const wasDisconnected = !state.connected;
    setState({ connected: true });
    // Catch up on whatever happened while disconnected.
    if (wasDisconnected) {
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
  source?.close();
  source = null;
}

export function resetData(): void {
  disconnectEvents();
  setState({ conversations: [], conversationsLoaded: false, threads: {}, contacts: [], dids: [], sync: null });
}
