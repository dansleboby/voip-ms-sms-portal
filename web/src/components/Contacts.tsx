import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ListChecks, Loader2, MessageSquarePlus, Search, SquareCheckBig, SquareMinus, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { navigate } from '../lib/router';
import { loadContacts, loadConversations, toast, toastError, useStore } from '../store';
import { BookChips, BookPicker, useBooks } from './Books';
import { ContactDialog } from './ContactDialog';
import { Avatar, Dialog } from './ui';
import { MAX_DELETE_IDS } from '../../../shared/contact';
import { formatPhone, searchDigits } from '../../../shared/phone';
import { foldText } from '../../../shared/text';
import type { ContactBook, ContactDto } from '../../../shared/types';

/** Deletes any number of contacts, MAX_DELETE_IDS per request; resolves with how many were deleted. */
async function deleteContacts(ids: number[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += MAX_DELETE_IDS) {
    deleted += (await api.deleteContacts(ids.slice(i, i + MAX_DELETE_IDS))).deleted;
  }
  await Promise.all([loadContacts(), loadConversations()]);
  return deleted;
}

export function Contacts() {
  const contacts = useStore((s) => s.contacts);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ContactDto | 'new' | null>(null);
  /** Ids ticked in selection mode; null outside of it. */
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const books = useBooks();
  /** The book an import goes to, while asking which (several books to choose from). */
  const [importBook, setImportBook] = useState<ContactBook | null>(null);

  const filtered = useMemo(() => {
    const q = foldText(query.trim());
    const digits = searchDigits(q);
    if (!q) return contacts;
    return contacts.filter((c) => foldText(c.name).includes(q) || (digits.length >= 3 && c.phones.some((p) => p.includes(digits))));
  }, [contacts, query]);

  // Contacts deleted meanwhile (on another device) drop out of the selection.
  const chosen = useMemo(() => (selection ? contacts.filter((c) => selection.has(c.id)).map((c) => c.id) : []), [contacts, selection]);
  // "Select all" takes what the search shows: search, then select all, deletes just those.
  const allShownChosen = selection !== null && filtered.length > 0 && filtered.every((c) => selection.has(c.id));

  const toggle = (id: number) =>
    setSelection((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllShown = () =>
    setSelection((s) => {
      const next = new Set(s);
      for (const c of filtered) {
        if (allShownChosen) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });

  const removeChosen = async () => {
    setDeleting(true);
    try {
      const deleted = await deleteContacts(chosen);
      toast(t('contacts.deletedMany', { count: deleted }));
      setSelection(null);
      setConfirming(false);
    } catch (err) {
      toastError(err);
    } finally {
      setDeleting(false);
    }
  };

  const importFile = async (file: File, book?: ContactBook) => {
    try {
      const result = await api.importContacts(await file.text(), book);
      await Promise.all([loadContacts(), loadConversations()]);
      // The wrong file is easy to pick: the contacts it added can go again in one tap.
      const undo = async () => {
        try {
          toast(t('contacts.deletedMany', { count: await deleteContacts(result.ids) }));
        } catch (err) {
          toastError(err);
        }
      };
      toast(t('contacts.imported', { imported: result.imported, skipped: result.skipped }), 'info', result.ids.length ? { label: t('common.undo'), run: () => void undo() } : undefined);
    } catch (err) {
      toastError(err);
    }
  };

  const header = selection ? (
    <header className="page-header">
      <button className="icon-btn" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={() => setSelection(null)}>
        <X size={22} />
      </button>
      <h2>{t('contacts.selected', { count: chosen.length })}</h2>
      <button
        className="btn text"
        onClick={toggleAllShown}
        disabled={filtered.length === 0}
        aria-label={t(allShownChosen ? 'contacts.selectNone' : 'contacts.selectAll')}
        title={t(allShownChosen ? 'contacts.selectNone' : 'contacts.selectAll')}
      >
        {allShownChosen ? <SquareMinus size={18} /> : <SquareCheckBig size={18} />}
        <span className="desktop-only">{t(allShownChosen ? 'contacts.selectNone' : 'contacts.selectAll')}</span>
      </button>
      <button className="btn danger" onClick={() => setConfirming(true)} disabled={chosen.length === 0} aria-label={t('common.delete')} title={t('common.delete')}>
        <Trash2 size={18} />
        <span className="desktop-only">{t('common.delete')}</span>
      </button>
    </header>
  ) : (
    <header className="page-header">
      <button className="icon-btn mobile-only" aria-label={t('common.back')} onClick={() => navigate({ name: 'home' })}>
        <ArrowLeft size={22} />
      </button>
      <h2>{t('contacts.title')}</h2>
      {contacts.length > 0 && (
        <button className="btn text" onClick={() => setSelection(new Set())} aria-label={t('contacts.select')} title={t('contacts.select')}>
          <ListChecks size={18} />
          <span className="desktop-only">{t('contacts.select')}</span>
        </button>
      )}
      <button className="btn text" onClick={() => (books.show ? setImportBook(books.initial()) : fileInput.current?.click())}>
        <Upload size={18} />
        <span className="desktop-only">{t('contacts.import')}</span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".vcf,text/vcard,text/x-vcard"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importFile(file, importBook ?? undefined);
          setImportBook(null);
          e.target.value = '';
        }}
      />
      <button className="btn tonal" onClick={() => setEditing('new')}>
        <UserPlus size={18} />
        <span className="desktop-only">{t('contacts.new')}</span>
      </button>
    </header>
  );

  return (
    <>
      {header}
      <div className="page">
        <div className="page-inner">
          <label className="search">
            <Search size={20} />
            <input placeholder={t('contacts.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {contacts.length === 0 ? (
            <p className="muted" style={{ textAlign: 'center', padding: 24 }}>
              {t('contacts.empty')}
            </p>
          ) : (
            <div className="card">
              {filtered.map((c) => {
                const ticked = selection?.has(c.id) ?? false;
                const activate = () => (selection ? toggle(c.id) : setEditing(c));
                return (
                  <div
                    key={c.id}
                    className={ticked ? 'contact-item selected' : 'contact-item'}
                    role={selection ? 'checkbox' : 'button'}
                    aria-checked={selection ? ticked : undefined}
                    tabIndex={0}
                    onClick={activate}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || (selection && e.key === ' ')) {
                        e.preventDefault();
                        activate();
                      }
                    }}
                  >
                    {selection && <input type="checkbox" className="contact-check" checked={ticked} readOnly tabIndex={-1} aria-hidden="true" />}
                    <Avatar name={c.name} seed={c.phones[0] ?? c.name} look={c} />
                    <div className="row-main">
                      <div className="row-title">{c.name}</div>
                      <div className="row-sub">{c.phones.map(formatPhone).join(' · ')}</div>
                      {books.show && <BookChips book={c.book} />}
                    </div>
                    {!selection && (
                      <button
                        className="icon-btn"
                        aria-label={t('contacts.message')}
                        title={t('contacts.message')}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate({ name: 'new', phone: c.phones[0] });
                        }}
                      >
                        <MessageSquarePlus size={20} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {editing && <ContactDialog contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {importBook && (
        <Dialog title={t('contacts.importInto')} onClose={() => setImportBook(null)}>
          <BookPicker books={books} value={importBook} onChange={setImportBook} />
          <div className="dialog-actions">
            <span className="spacer" />
            <button type="button" className="btn text" onClick={() => setImportBook(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
              <Upload size={18} />
              {t('contacts.importStart')}
            </button>
          </div>
        </Dialog>
      )}
      {confirming && (
        <Dialog title={t('contacts.deleteManyTitle', { count: chosen.length })} onClose={() => !deleting && setConfirming(false)}>
          <p className="dialog-text">{t('contacts.deleteManyBody')}</p>
          <div className="dialog-actions">
            <span className="spacer" />
            <button type="button" className="btn text" onClick={() => setConfirming(false)} disabled={deleting}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn danger-filled" onClick={() => void removeChosen()} disabled={deleting}>
              {deleting && <Loader2 size={18} className="spin" />}
              {t('common.delete')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
