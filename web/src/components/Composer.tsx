import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FileText, Loader2, Paperclip, SendHorizontal, X } from 'lucide-react';
import { t } from '../i18n';
import { AttachmentTooLarge, prepareAttachment } from '../lib/image';
import { prefs } from '../lib/prefs';
import { sendMessage, toast, toastError } from '../store';
import { checkOutgoing, MAX_ATTACHMENTS, SMS_MAX_BYTES } from '../../../shared/message';
import type { ConversationDto } from '../../../shared/types';

interface Pending {
  id: number;
  file: File | null;
  name: string;
  preview: string | null;
}

let pendingId = 0;
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

/**
 * Message box with the SMS/MMS rule built in: the byte counter follows
 * VoIP.ms's 160-byte SMS limit and anything bigger, or with attachments,
 * goes out as MMS.
 */
export function Composer({
  did,
  to,
  disabled,
  mmsAvailable,
  autoFocus,
  onSent,
}: {
  did: string | null;
  to: string | null;
  disabled?: boolean;
  mmsAvailable: boolean;
  autoFocus?: boolean;
  onSent?: (conversation: ConversationDto) => void;
}) {
  const draftKey = did && to ? (`draft:${did}:${to}` as const) : null;
  const [body, setBody] = useState(() => (draftKey ? prefs.get(draftKey) ?? '' : ''));
  const [items, setItems] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draftKey) prefs.set(draftKey, body || null);
  }, [draftKey, body]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [body]);

  useEffect(() => () => items.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = items.filter((i) => i.file);
  const preparing = items.some((i) => !i.file);
  const check = useMemo(() => checkOutgoing(body, items.length), [body, items.length]);
  const blocked = check.problem !== null || (check.kind === 'mms' && !mmsAvailable);
  const canSend = !!did && !!to && !disabled && !sending && !preparing && !blocked;

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].slice(0, MAX_ATTACHMENTS - items.length);
    if (files.length > list.length) toast(t('composer.tooMany'), 'error');
    for (const file of list) {
      const id = ++pendingId;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setItems((cur) => [...cur, { id, file: null, name: file.name, preview }]);
      try {
        const prepared = await prepareAttachment(file);
        setItems((cur) => cur.map((i) => (i.id === id ? { ...i, file: prepared } : i)));
      } catch (err) {
        setItems((cur) => cur.filter((i) => i.id !== id));
        if (preview) URL.revokeObjectURL(preview);
        toast(err instanceof AttachmentTooLarge ? t('error.attachment_too_large') : t('error.unsupported_attachment'), 'error');
      }
    }
  };

  const remove = (id: number) => {
    setItems((cur) => {
      const item = cur.find((i) => i.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return cur.filter((i) => i.id !== id);
    });
  };

  const send = async () => {
    if (!canSend || !did || !to) return;
    setSending(true);
    const sentBody = body;
    const sentItems = new Set(ready.map((i) => i.id));
    try {
      const conversation = await sendMessage({ did, to, body: body.trim() ? body : '', files: ready.map((i) => i.file!) });
      // Keep whatever was typed or attached while the message was being sent.
      items.forEach((i) => sentItems.has(i.id) && i.preview && URL.revokeObjectURL(i.preview));
      setItems((cur) => cur.filter((i) => !sentItems.has(i.id)));
      setBody((cur) => (cur === sentBody ? '' : cur));
      onSent?.(conversation);
      textarea.current?.focus();
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on desktop; on touch screens it inserts a line break like a phone keyboard.
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const showCounter = check.kind === 'mms' || check.bytes > SMS_MAX_BYTES - 40;
  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-row">
          <div
            className="composer-box"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
            }}
          >
            {items.length > 0 && (
              <div className="attach-previews">
                {items.map((i) => (
                  <div key={i.id} className="attach-preview" title={i.name}>
                    {i.preview ? <img src={i.preview} alt="" /> : <FileText size={24} />}
                    {!i.file && (
                      <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgb(0 0 0 / .35)', color: '#fff' }}>
                        <Loader2 size={20} className="spin" aria-label={t('composer.compressing')} />
                      </span>
                    )}
                    <button className="remove" aria-label={t('composer.remove')} onClick={() => remove(i.id)}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-input-row">
              <button
                className="icon-btn"
                aria-label={t('composer.attach')}
                title={t('composer.attach')}
                disabled={items.length >= MAX_ATTACHMENTS || !mmsAvailable}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={20} />
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                multiple
                accept="image/*,video/*,audio/*,.vcf,text/vcard"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <textarea
                ref={textarea}
                rows={1}
                value={body}
                autoFocus={autoFocus}
                disabled={disabled}
                placeholder={check.kind === 'mms' ? t('composer.placeholderMms') : t('composer.placeholderSms')}
                aria-label={t('composer.placeholderSms')}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={(e) => {
                  if (e.clipboardData.files.length) {
                    e.preventDefault();
                    void addFiles(e.clipboardData.files);
                  }
                }}
              />
            </div>
            {(showCounter || blocked) && (
              <div className="composer-meta" title={t('composer.counterHint')}>
                {check.kind === 'mms' && <span className="kind-chip">{t('composer.mms')}</span>}
                {check.problem === 'too_long' ? (
                  <span className="over">{t('composer.tooLong')}</span>
                ) : check.kind === 'mms' && !mmsAvailable ? (
                  <span className="over">{t('composer.mmsUnavailable')}</span>
                ) : (
                  check.bytes > 0 && <span>{check.kind === 'sms' ? `${check.bytes}/${SMS_MAX_BYTES}` : `${check.bytes}/2048`}</span>
                )}
              </div>
            )}
          </div>
          <button className="send-btn" aria-label={t('composer.send')} title={t('composer.send')} disabled={!canSend} onClick={send}>
            {sending ? <Loader2 size={22} className="spin" /> : <SendHorizontal size={22} />}
          </button>
        </div>
      </div>
    </div>
  );
}
