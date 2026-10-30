import { t } from '../i18n';
import { didName } from '../lib/format';
import { useStore } from '../store';
import type { ContactBook, DidDto } from '../../../shared/types';

export interface Books {
  /** Whether there is a choice to make: the Team mode, or several numbers. */
  show: boolean;
  team: boolean;
  /** Every number's book: the owner's and the admins'. */
  canAll: boolean;
  /** The numbers whose books whoever is signed in may put contacts in. */
  numbers: DidDto[];
  /** Where a new contact goes, made from a conversation on `did` or from the contact list. */
  initial: (did?: string) => ContactBook;
  label: (book: ContactBook) => string;
}

export function useBooks(): Books {
  const session = useStore((s) => s.session);
  const dids = useStore((s) => s.dids);
  const team = session?.mode === 'team';
  const canAll = session?.user?.role !== 'user';
  const numbers = dids.filter((d) => d.visible && d.smsEnabled && d.canSend);
  const show = team || dids.filter((d) => d.visible && d.smsEnabled).length > 1;
  return {
    show,
    team,
    canAll,
    numbers,
    // In the Team mode, a contact made from a conversation goes in its number's book by default.
    initial: (did) =>
      team && did && numbers.some((d) => d.did === did) ? { kind: 'numbers', dids: [did] } : canAll ? { kind: 'all' } : { kind: 'personal' },
    label: (book) =>
      book.kind === 'personal'
        ? t('contacts.bookPersonal')
        : book.kind === 'all'
          ? t('contacts.bookAll')
          : book.dids.map((did) => didName(dids.find((d) => d.did === did), did)).join(', '),
  };
}

/** A contact's book under its name, like the number chips of the conversation list. */
export function BookChips({ book }: { book: ContactBook }) {
  const dids = useStore((s) => s.dids);
  if (book.kind === 'all') return null;
  return (
    <div className="conv-chips">
      {book.kind === 'personal' ? (
        <span className="did-chip" style={{ ['--chip-color' as string]: 'var(--outline)' }}>
          {t('contacts.bookPersonal')}
        </span>
      ) : (
        book.dids.map((did) => {
          const d = dids.find((x) => x.did === did);
          return (
            <span key={did} className="did-chip" style={{ ['--chip-color' as string]: d?.color ?? 'var(--outline)' }}>
              <span className="did-dot" style={{ background: d?.color ?? 'var(--outline)' }} />
              {didName(d, did)}
            </span>
          );
        })
      )}
    </div>
  );
}

/**
 * Which book a contact is in, as chips: every number's, some numbers' (several
 * can be picked), or one's own (Team mode).
 */
export function BookPicker({ books, value, onChange }: { books: Books; value: ContactBook; onChange: (book: ContactBook) => void }) {
  const toggle = (did: string) => {
    if (value.kind !== 'numbers') return onChange({ kind: 'numbers', dids: [did] });
    const dids = value.dids.includes(did) ? value.dids.filter((d) => d !== did) : [...value.dids, did];
    onChange(dids.length ? { kind: 'numbers', dids } : books.initial());
  };
  return (
    <div className="field">
      <span>{t('contacts.book')}</span>
      <div className="book-chips" role="group" aria-label={t('contacts.book')}>
        {books.canAll && (
          <button type="button" className="filter-chip" aria-pressed={value.kind === 'all'} onClick={() => onChange({ kind: 'all' })}>
            {t('contacts.bookAll')}
          </button>
        )}
        {books.numbers.map((d) => (
          <button
            key={d.did}
            type="button"
            className="filter-chip"
            aria-pressed={value.kind === 'numbers' && value.dids.includes(d.did)}
            onClick={() => toggle(d.did)}
          >
            <span className="did-dot" style={{ background: d.color }} />
            {didName(d, d.did)}
          </button>
        ))}
        {books.team && (
          <button type="button" className="filter-chip" aria-pressed={value.kind === 'personal'} onClick={() => onChange({ kind: 'personal' })}>
            {t('contacts.bookPersonal')}
          </button>
        )}
      </div>
      <small className="muted">{t(value.kind === 'personal' ? 'contacts.bookPersonalHint' : books.team ? 'contacts.bookTeamHint' : 'contacts.bookHint')}</small>
    </div>
  );
}
