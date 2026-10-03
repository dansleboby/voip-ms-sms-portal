import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { didName } from '../lib/format';
import { navigate } from '../lib/router';
import { useStore } from '../store';
import { Composer } from './Composer';
import { Avatar } from './ui';
import { formatPhone, isValidNanp, normalizePhone, searchDigits } from '../../../shared/phone';
import { foldText } from '../../../shared/text';

interface Suggestion {
  name: string;
  phone: string;
}

export function NewConversation({ initialPhone }: { initialPhone?: string }) {
  const dids = useStore((s) => s.dids);
  const contacts = useStore((s) => s.contacts);
  const didFilter = useStore((s) => s.didFilter);
  const sendable = useMemo(() => dids.filter((d) => d.visible && d.smsEnabled), [dids]);
  const [from, setFrom] = useState<string | null>(null);
  const [query, setQuery] = useState(initialPhone ? formatPhone(initialPhone) : '');
  const [recipient, setRecipient] = useState<Suggestion | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (from && sendable.some((d) => d.did === from)) return;
    setFrom(sendable.find((d) => d.did === didFilter)?.did ?? sendable[0]?.did ?? null);
  }, [sendable, didFilter, from]);

  // Prefilled number (from the contacts page): pick it once, without undoing a later change.
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPhone || prefilled.current === initialPhone) return;
    prefilled.current = initialPhone;
    const phone = normalizePhone(initialPhone);
    const contact = contacts.find((c) => c.phones.includes(phone));
    setRecipient({ name: contact?.name ?? formatPhone(phone), phone });
  }, [initialPhone, contacts]);

  // An existing conversation for this pair takes over.
  useEffect(() => {
    if (!recipient || !from) return;
    let cancelled = false;
    api
      .lookupConversation(from, recipient.phone)
      .then(({ conversation }) => {
        if (!cancelled && conversation?.lastMessage) navigate({ name: 'conversation', id: conversation.id }, { replace: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recipient, from]);

  const suggestions = useMemo((): Suggestion[] => {
    const q = foldText(query.trim());
    const digits = searchDigits(q);
    const list: Suggestion[] = [];
    if (isValidNanp(digits)) list.push({ name: formatPhone(digits), phone: digits });
    if (q) {
      for (const c of contacts) {
        for (const phone of c.phones) {
          if (foldText(c.name).includes(q) || (digits.length >= 3 && phone.includes(digits))) {
            if (!list.some((s) => s.phone === phone)) list.push({ name: c.name, phone });
          }
        }
      }
    } else {
      for (const c of contacts) for (const phone of c.phones) list.push({ name: c.name, phone });
    }
    return list.slice(0, 50);
  }, [query, contacts]);

  useEffect(() => setActive(0), [query]);

  const fromDid = sendable.find((d) => d.did === from);

  return (
    <>
      <header className="thread-header">
        <button className="icon-btn" aria-label={t('common.back')} onClick={() => history.back()}>
          <ArrowLeft size={22} />
        </button>
        <div className="thread-title">
          <h2>{t('new.title')}</h2>
        </div>
      </header>
      <div className="recipient">
        <span className="muted">{t('new.to')}</span>
        {recipient ? (
          <button className="filter-chip" aria-pressed onClick={() => setRecipient(null)} title={formatPhone(recipient.phone)}>
            {recipient.name} ✕
          </button>
        ) : (
          <input
            autoFocus
            placeholder={t('new.toPlaceholder')}
            value={query}
            inputMode="text"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, suggestions.length - 1));
              if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
              if (e.key === 'Enter' && suggestions[active]) {
                // Otherwise the same Enter lands in the message box that takes focus right after.
                e.preventDefault();
                setRecipient(suggestions[active]!);
              }
            }}
          />
        )}
        {sendable.length > 0 && (
          <label className="from-select">
            <span className="did-dot" style={{ background: fromDid?.color }} />
            <span className="sr-only">{t('new.from')}</span>
            <select value={from ?? ''} onChange={(e) => setFrom(e.target.value)} aria-label={t('new.from')}>
              {sendable.map((d) => (
                <option key={d.did} value={d.did}>
                  {t('new.fromDid', { name: didName(d, d.did) })}
                  {d.label ? ` · ${formatPhone(d.did)}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {sendable.length === 0 ? (
        <div className="placeholder-pane">{t('new.noDid')}</div>
      ) : recipient ? (
        <div className="thread-empty" />
      ) : (
        <div className="suggestions" role="listbox">
          {query.trim() && suggestions.length === 0 && <div className="list-empty">{t('new.invalid')}</div>}
          {suggestions.map((s, i) => (
            <button
              key={`${s.phone}-${s.name}`}
              role="option"
              aria-selected={i === active}
              className={`suggestion${i === active ? ' active' : ''}`}
              onClick={() => setRecipient(s)}
            >
              <Avatar name={s.name} seed={s.phone} />
              <div>
                <div>{s.name === formatPhone(s.phone) ? t('new.sendTo', { phone: s.name }) : s.name}</div>
                {s.name !== formatPhone(s.phone) && <div className="muted">{formatPhone(s.phone)}</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      {recipient && fromDid && (
        <Composer
          key={`${fromDid.did}:${recipient.phone}`}
          did={fromDid.did}
          to={recipient.phone}
          mmsAvailable={fromDid.mmsAvailable}
          autoFocus
          onSent={(conversation) => navigate({ name: 'conversation', id: conversation.id }, { replace: true })}
        />
      )}
    </>
  );
}
