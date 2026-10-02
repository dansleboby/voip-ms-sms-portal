import type {
  ConnectionTestDto,
  ContactDto,
  ConversationDto,
  DidDto,
  MessageDto,
  SessionDto,
  SetupStatusDto,
  SyncStatusDto,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Called when the server says the session is gone. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'offline');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (e.g. a proxy error page).
  }
  if (!res.ok) {
    const payload = (data ?? {}) as Record<string, unknown>;
    const code = typeof payload.error === 'string' ? payload.error : res.status === 429 ? 'rate_limited' : `http_${res.status}`;
    if (res.status === 401 && code === 'unauthorized') onUnauthorized();
    throw new ApiError(res.status, code, payload);
  }
  return data as T;
}

export const api = {
  session: () => request<SessionDto>('GET', '/api/session'),
  login: (password: string) => request<{ ok: true }>('POST', '/api/auth/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  setupStatus: () => request<SetupStatusDto>('GET', '/api/setup/status'),
  saveCredentials: (username: string, password: string) =>
    request<ConnectionTestDto>('POST', '/api/setup/credentials', { username, password }),
  testConnection: () => request<ConnectionTestDto>('POST', '/api/setup/test'),
  refreshDids: () => request<DidDto[]>('GET', '/api/setup/dids'),
  importHistory: (days: number) => request<{ ok: true }>('POST', '/api/setup/import', { days }),
  completeSetup: () => request<{ ok: true }>('POST', '/api/setup/complete'),

  dids: () => request<DidDto[]>('GET', '/api/dids'),
  updateDid: (did: string, patch: Partial<Pick<DidDto, 'label' | 'color' | 'visible' | 'position'>>) =>
    request<DidDto>('PATCH', `/api/dids/${did}`, patch),

  conversations: (params: { q?: string; archived?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.archived !== undefined) query.set('archived', params.archived ? '1' : '0');
    const qs = query.toString();
    return request<ConversationDto[]>('GET', `/api/conversations${qs ? `?${qs}` : ''}`);
  },
  conversation: (id: number) => request<ConversationDto>('GET', `/api/conversations/${id}`),
  updateConversation: (id: number, patch: { archived: boolean }) =>
    request<ConversationDto>('PATCH', `/api/conversations/${id}`, patch),
  lookupConversation: (did: string, phone: string) =>
    request<{ conversation: ConversationDto | null }>(
      'GET',
      `/api/conversations/lookup?did=${encodeURIComponent(did)}&phone=${encodeURIComponent(phone)}`,
    ),
  messages: (conversationId: number, before?: number) =>
    request<MessageDto[]>('GET', `/api/conversations/${conversationId}/messages?limit=50${before ? `&before=${before}` : ''}`),
  markRead: (conversationId: number) => request<{ ok: true }>('POST', `/api/conversations/${conversationId}/read`),

  send: (input: { did: string; to: string; body: string; files: File[] }) => {
    const form = new FormData();
    form.set('did', input.did);
    form.set('to', input.to);
    form.set('body', input.body);
    for (const file of input.files) form.append('files', file, file.name);
    return request<{ message: MessageDto; conversation: ConversationDto }>('POST', '/api/messages', form);
  },
  retry: (messageId: number) => request<MessageDto>('POST', `/api/messages/${messageId}/retry`),
  retryMedia: (attachmentId: number) => request<{ ok: true }>('POST', `/api/media/${attachmentId}/retry`),

  contacts: () => request<ContactDto[]>('GET', '/api/contacts'),
  createContact: (c: { name: string; phones: string[]; notes?: string | null; force?: boolean }) =>
    request<ContactDto>('POST', '/api/contacts', c),
  updateContact: (id: number, c: { name: string; phones: string[]; notes?: string | null; force?: boolean }) =>
    request<ContactDto>('PUT', `/api/contacts/${id}`, c),
  deleteContact: (id: number) => request<{ ok: true }>('DELETE', `/api/contacts/${id}`),
  importContacts: (vcard: string) => request<{ imported: number; skipped: number }>('POST', '/api/contacts/import', { vcard }),

  pushKey: () => request<{ publicKey: string }>('GET', '/api/push/key'),
  savePushSubscription: (subscription: object) => request<{ ok: true }>('POST', '/api/push/subscriptions', subscription),
  unsubscribePush: (endpoint: string) => request<{ ok: boolean }>('POST', '/api/push/unsubscribe', { endpoint }),
  testPush: (endpoint: string) => request<{ ok: true }>('POST', '/api/push/test', { endpoint }),
  presence: (tab: string, visible: boolean) =>
    fetch('/api/presence', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, visible }),
      // Still delivered when the page is being hidden or frozen.
      keepalive: true,
    }).catch(() => undefined),

  syncStatus: () => request<SyncStatusDto>('GET', '/api/sync/status'),
  syncNow: () => request<SyncStatusDto>('POST', '/api/sync/now'),
};
