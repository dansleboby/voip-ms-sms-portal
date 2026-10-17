import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArchiveRestore, ArrowLeft, Download, FileText, Trash2, UserPen, UserPlus } from 'lucide-react';
import { errorText, t } from '../i18n';
import { didName, displayName, formatDayHeader, formatTime, isEmojiOnly, isSameDay, linkify } from '../lib/format';
import { clearNotifications } from '../lib/push';
import { navigate } from '../lib/router';
import {
  deleteConversation,
  deleteMessage,
  fetchConversation,
  getState,
  loadOlder,
  loadThread,
  markRead,
  retryMedia,
  retryMessage,
  setActiveConversation,
  setArchived,
  threadOf,
  toast,
  toastError,
  useStore,
} from '../store';
import { AudioPlayer } from './AudioPlayer';
import { Composer } from './Composer';
import { ContactDialog } from './ContactDialog';
import { DeleteDialog } from './DeleteDialog';
import { Avatar, Lightbox, MenuButton } from './ui';
import { formatPhone, isValidNanp } from '../../../shared/phone';
import type { AttachmentDto, MessageDto } from '../../../shared/types';

const GROUP_GAP_MS = 5 * 60 * 1000;

export function Thread({ id }: { id: number }) {
  const conversation = useStore((s) => s.known[id]);
  const thread = useStore((s) => threadOf(s, id));
  const dids = useStore((s) => s.dids);
  const contacts = useStore((s) => s.contacts);
  const [editingContact, setEditingContact] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setActiveConversation(id);
    void loadThread(id).catch(toastError);
    if (!getState().known[id]) fetchConversation(id).catch(() => navigate({ name: 'home' }, { replace: true }));
    return () => setActiveConversation(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Mark as read while the conversation is on screen.
  const unread = conversation?.unreadCount ?? 0;
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      if (unread > 0) void markRead(id);
      void clearNotifications(id).catch(() => undefined);
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
  const back = () => navigate(getState().archiveView ? { name: 'archived' } : { name: 'home' });

  const toggleArchive = async () => {
    const archive = !conversation.archived;
    try {
      await setArchived(id, archive);
    } catch (err) {
      toastError(err);
      return;
    }
    if (archive) {
      back();
      toast(t('thread.archived'), 'info', { label: t('common.undo'), run: () => void setArchived(id, false).catch(toastError) });
    } else {
      toast(t('thread.unarchived'));
    }
  };

  const actions = [
    ...(shortCode
      ? []
      : [
          {
            icon: conversation.contact ? <UserPen size={22} /> : <UserPlus size={22} />,
            label: conversation.contact ? t('thread.editContact') : t('thread.addContact'),
            onSelect: () => setEditingContact(true),
          },
        ]),
    {
      icon: conversation.archived ? <ArchiveRestore size={22} /> : <Archive size={22} />,
      label: conversation.archived ? t('thread.unarchive') : t('thread.archive'),
      onSelect: () => void toggleArchive(),
    },
    { icon: <Trash2 size={22} />, label: t('thread.delete'), danger: true, onSelect: () => setDeleting(true) },
  ];

  return (
    <>
      <header className="thread-header">
        <button className="icon-btn mobile-only" aria-label={t('common.back')} onClick={back}>
          <ArrowLeft size={22} />
        </button>
        <Avatar name={name} seed={conversation.phone} look={conversation.contact} />
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
        {/* A button each on large screens; on phones, a menu leaves the name its room. */}
        <div className="thread-actions desktop-only">
          {actions.map((action) => (
            <button key={action.label} className="icon-btn" aria-label={action.label} title={action.label} onClick={action.onSelect}>
              {action.icon}
            </button>
          ))}
        </div>
        <div className="mobile-only">
          <MenuButton label={t('thread.more')} items={actions} />
        </div>
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
      {deleting && (
        <DeleteDialog
          what="conversation"
          onClose={() => setDeleting(false)}
          onConfirm={async (atVoipMs) => {
            await deleteConversation(id, atVoipMs);
            back();
            toast(t('thread.deleted'));
          }}
        />
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
  // The message tapped, which shows its actions; the one asked about before deleting.
  const [selected, setSelected] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<MessageDto | null>(null);

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

  // So does a phone's keyboard opening, which shrinks the list from below.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(onMediaLoad);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onMediaLoad]);

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
                selected={m.id === selected}
                onSelect={() => setSelected((current) => (current === m.id ? null : m.id))}
                onDelete={() => setDeleting(m)}
                onOpenImage={setLightbox}
                onMediaLoad={onMediaLoad}
              />
            </Fragment>
          );
        })}
      </div>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {deleting && (
        <DeleteDialog
          what="message"
          onClose={() => setDeleting(null)}
          onConfirm={async (atVoipMs) => {
            await deleteMessage(deleting, atVoipMs);
            setSelected(null);
            toast(t('thread.messageDeleted'));
          }}
        />
      )}
    </div>
  );
}

function MessageView({
  message: m,
  first,
  last,
  showStatus,
  selected,
  onSelect,
  onDelete,
  onOpenImage,
  onMediaLoad,
}: {
  message: MessageDto;
  first: boolean;
  last: boolean;
  showStatus: boolean;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onOpenImage: (src: string) => void;
  onMediaLoad: () => void;
}) {
  const classes = [
    'msg',
    m.direction,
    first && 'first',
    last && 'last',
    m.status === 'failed' && 'failed',
    m.status === 'sending' && 'sending',
    selected && 'selected',
  ]
    .filter(Boolean)
    .join(' ');
  // A tap on the message (not on a link, a picture or a button, nor the end of a text selection) shows its actions.
  const select = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button, img, video, .audio-player') || window.getSelection()?.toString()) return;
    onSelect();
  };
  const emoji = m.attachments.length === 0 && isEmojiOnly(m.body);
  const delivered = m.carrierStatus && /deliver/i.test(m.carrierStatus);

  return (
    <div className={classes} onClick={select}>
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
        (last || selected || (showStatus && m.status === 'sending')) && (
          <div className="msg-meta">
            {formatTime(m.sentAt)}
            {m.kind === 'mms' && <span>· MMS</span>}
            {showStatus && m.direction === 'out' && (
              <span>· {m.status === 'sending' ? t('status.sending') : delivered ? t('status.delivered') : t('status.sent')}</span>
            )}
          </div>
        )
      )}
      {selected && m.status !== 'sending' && (
        <div className="msg-actions">
          <button type="button" className="btn danger small" onClick={onDelete}>
            <Trash2 size={16} />
            {t('common.delete')}
          </button>
        </div>
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
  if (mime.startsWith('audio/')) return <AudioPlayer url={a.url} />;
  return (
    <a className="file-chip" href={a.url} download>
      {mime.includes('vcard') ? <FileText size={18} /> : <Download size={18} />}
      {mime.includes('vcard') ? 'vCard' : t('attachment.file')}
    </a>
  );
}
