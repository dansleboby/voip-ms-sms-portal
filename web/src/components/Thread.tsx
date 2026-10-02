import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Download, FileText, UserPen, UserPlus } from 'lucide-react';
import { api } from '../api';
import { errorText, t } from '../i18n';
import { didName, displayName, formatDayHeader, formatTime, isEmojiOnly, isSameDay, linkify } from '../lib/format';
import { navigate } from '../lib/router';
import {
  loadOlder,
  loadThread,
  markRead,
  retryMedia,
  retryMessage,
  setActiveConversation,
  threadOf,
  toastError,
  useStore,
} from '../store';
import { Composer } from './Composer';
import { ContactDialog } from './ContactDialog';
import { Avatar, Lightbox } from './ui';
import { formatPhone, isValidNanp } from '../../../shared/phone';
import type { AttachmentDto, ConversationDto, MessageDto } from '../../../shared/types';

const GROUP_GAP_MS = 5 * 60 * 1000;

export function Thread({ id }: { id: number }) {
  const fromList = useStore((s) => s.conversations.find((c) => c.id === id));
  const [fetched, setFetched] = useState<ConversationDto | null>(null);
  const conversation = fromList ?? fetched;
  const thread = useStore((s) => threadOf(s, id));
  const dids = useStore((s) => s.dids);
  const contacts = useStore((s) => s.contacts);
  const [editingContact, setEditingContact] = useState(false);

  useEffect(() => {
    setActiveConversation(id);
    void loadThread(id).catch(toastError);
    if (!fromList) api.conversation(id).then(setFetched).catch(() => navigate({ name: 'home' }, { replace: true }));
    return () => setActiveConversation(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Mark as read while the conversation is on screen.
  const unread = conversation?.unreadCount ?? 0;
  useEffect(() => {
    const check = () => {
      if (unread > 0 && document.visibilityState === 'visible') void markRead(id);
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [id, unread]);

  if (!conversation) return <div className="placeholder-pane">{t('common.loading')}</div>;

  const did = dids.find((d) => d.did === conversation.did);
  const name = displayName(conversation.phone, conversation.contact);
  const contact = conversation.contact ? contacts.find((c) => c.id === conversation.contact!.id) ?? null : null;
  const shortCode = !isValidNanp(conversation.phone);

  return (
    <>
      <header className="thread-header">
        <button className="icon-btn mobile-only" aria-label={t('common.back')} onClick={() => navigate({ name: 'home' })}>
          <ArrowLeft size={22} />
        </button>
        <Avatar name={name} seed={conversation.phone} />
        <div className="thread-title">
          <h2>{name}</h2>
          <div className="thread-sub">
            {conversation.contact && <span>{formatPhone(conversation.phone)}</span>}
            {shortCode && <span>{t('thread.shortCode')}</span>}
            {did && (
              <>
                {(conversation.contact || shortCode) && <span aria-hidden="true">·</span>}
                <span>{t('thread.via')}</span>
                <span className="did-chip" style={{ ['--chip-color' as string]: did.color }}>
                  <span className="did-dot" style={{ background: did.color }} />
                  {didName(did, did.did)}
                  {did.label && ` · ${formatPhone(did.did)}`}
                </span>
              </>
            )}
          </div>
        </div>
        {!shortCode && (
          <button
            className="icon-btn"
            aria-label={conversation.contact ? t('thread.editContact') : t('thread.addContact')}
            title={conversation.contact ? t('thread.editContact') : t('thread.addContact')}
            onClick={() => setEditingContact(true)}
          >
            {conversation.contact ? <UserPen size={22} /> : <UserPlus size={22} />}
          </button>
        )}
      </header>

      <MessageList conversationId={id} messages={thread.items} hasMore={thread.hasMore} loading={thread.loading} loaded={thread.loaded} />

      {shortCode && <div className="banner info" style={{ margin: '0 16px 4px' }}>{t('thread.noReply')}</div>}
      <Composer
        key={id}
        did={conversation.did}
        to={conversation.phone}
        mmsAvailable={did?.mmsAvailable ?? true}
        disabled={did ? !did.smsEnabled : false}
        autoFocus={!window.matchMedia('(pointer: coarse)').matches}
      />

      {editingContact && (
        <ContactDialog contact={contact} initialPhone={conversation.phone} onClose={() => setEditingContact(false)} />
      )}
    </>
  );
}

function MessageList({
  conversationId,
  messages,
  hasMore,
  loading,
  loaded,
}: {
  conversationId: number;
  messages: MessageDto[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousHeight = useRef<number | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120 && hasMore && !loading) {
      previousHeight.current = el.scrollHeight;
      void loadOlder(conversationId);
    }
  };

  // Keep the view pinned to the newest message, or steady when older ones are prepended.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (previousHeight.current !== null) {
      el.scrollTop += el.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Images load after layout: keep following the bottom while they do.
  const onMediaLoad = useCallback(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  const lastOutgoingId = useMemo(() => [...messages].reverse().find((m) => m.direction === 'out')?.id, [messages]);

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      <div className="messages-inner">
        {hasMore && (
          <button
            className="btn text small load-older"
            disabled={loading}
            onClick={() => {
              previousHeight.current = scroller.current?.scrollHeight ?? null;
              void loadOlder(conversationId);
            }}
          >
            {t('thread.loadOlder')}
          </button>
        )}
        {loaded && messages.length === 0 && <div className="thread-empty">{t('thread.empty')}</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const newDay = !prev || !isSameDay(prev.sentAt, m.sentAt);
          const first = newDay || prev!.direction !== m.direction || m.sentAt - prev!.sentAt > GROUP_GAP_MS;
          const last =
            !next || !isSameDay(next.sentAt, m.sentAt) || next.direction !== m.direction || next.sentAt - m.sentAt > GROUP_GAP_MS;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-sep">{formatDayHeader(m.sentAt)}</div>}
              <MessageView
                message={m}
                first={first}
                last={last}
                showStatus={m.id === lastOutgoingId}
                onOpenImage={setLightbox}
                onMediaLoad={onMediaLoad}
              />
            </Fragment>
          );
        })}
      </div>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function MessageView({
  message: m,
  first,
  last,
  showStatus,
  onOpenImage,
  onMediaLoad,
}: {
  message: MessageDto;
  first: boolean;
  last: boolean;
  showStatus: boolean;
  onOpenImage: (src: string) => void;
  onMediaLoad: () => void;
}) {
  const classes = ['msg', m.direction, first && 'first', last && 'last', m.status === 'failed' && 'failed', m.status === 'sending' && 'sending']
    .filter(Boolean)
    .join(' ');
  const emoji = m.attachments.length === 0 && isEmojiOnly(m.body);
  const delivered = m.carrierStatus && /deliver/i.test(m.carrierStatus);

  return (
    <div className={classes}>
      {m.attachments.length > 0 && (
        <div className="media-group">
          {m.attachments.map((a) => (
            <AttachmentView key={a.id} attachment={a} onOpenImage={onOpenImage} onLoad={onMediaLoad} />
          ))}
        </div>
      )}
      {m.body && (
        <div className={`bubble${emoji ? ' emoji' : ''}`}>
          {linkify(m.body).map((part, i) =>
            part.href ? (
              <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">
                {part.text}
              </a>
            ) : (
              <Fragment key={i}>{part.text}</Fragment>
            ),
          )}
        </div>
      )}
      {m.status === 'failed' ? (
        <div className="msg-meta error" role="alert">
          <AlertCircle size={14} />
          {t('status.failed')} {m.error && errorText(m.error)}
          <button onClick={() => void retryMessage(m.id)}>{t('status.tapRetry')}</button>
        </div>
      ) : (
        (last || (showStatus && m.status === 'sending')) && (
          <div className="msg-meta">
            {formatTime(m.sentAt)}
            {m.kind === 'mms' && <span>· MMS</span>}
            {showStatus && m.direction === 'out' && (
              <span>· {m.status === 'sending' ? t('status.sending') : delivered ? t('status.delivered') : t('status.sent')}</span>
            )}
          </div>
        )
      )}
    </div>
  );
}

function AttachmentView({
  attachment: a,
  onOpenImage,
  onLoad,
}: {
  attachment: AttachmentDto;
  onOpenImage: (src: string) => void;
  onLoad: () => void;
}) {
  if (a.status === 'pending') return <div className="media placeholder loading">{t('attachment.pending')}</div>;
  if (a.status === 'failed' || !a.url) {
    return (
      <div className="media placeholder" style={{ gap: 4, alignContent: 'center' }}>
        <span>{t('attachment.failed')}</span>
        <button className="btn text small" onClick={() => void retryMedia(a.id)}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  const mime = a.mime ?? '';
  if (mime.startsWith('image/')) {
    return (
      <div className="media">
        <button onClick={() => onOpenImage(a.url!)} aria-label={t('list.photo')}>
          <img src={a.url} alt="" loading="lazy" onLoad={onLoad} />
        </button>
      </div>
    );
  }
  if (mime.startsWith('video/')) {
    return (
      <div className="media">
        <video src={a.url} controls preload="metadata" onLoadedMetadata={onLoad} />
      </div>
    );
  }
  if (mime.startsWith('audio/')) {
    return (
      <div className="media">
        <audio src={a.url} controls preload="metadata" />
      </div>
    );
  }
  return (
    <a className="file-chip" href={a.url} download>
      {mime.includes('vcard') ? <FileText size={18} /> : <Download size={18} />}
      {mime.includes('vcard') ? 'vCard' : t('attachment.file')}
    </a>
  );
}
