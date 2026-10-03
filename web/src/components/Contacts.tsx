import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, MessageSquarePlus, Search, Upload, UserPlus } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { navigate } from '../lib/router';
import { loadContacts, loadConversations, toast, toastError, useStore } from '../store';
import { ContactDialog } from './ContactDialog';
import { Avatar } from './ui';
import { formatPhone, searchDigits } from '../../../shared/phone';
import { foldText } from '../../../shared/text';
import type { ContactDto } from '../../../shared/types';

export function Contacts() {
  const contacts = useStore((s) => s.contacts);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ContactDto | 'new' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = foldText(query.trim());
    const digits = searchDigits(q);
    if (!q) return contacts;
    return contacts.filter((c) => foldText(c.name).includes(q) || (digits.length >= 3 && c.phones.some((p) => p.includes(digits))));
  }, [contacts, query]);

  const importFile = async (file: File) => {
    try {
      const result = await api.importContacts(await file.text());
      toast(t('contacts.imported', result));
      await Promise.all([loadContacts(), loadConversations()]);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <header className="page-header">
        <button className="icon-btn mobile-only" aria-label={t('common.back')} onClick={() => navigate({ name: 'home' })}>
          <ArrowLeft size={22} />
        </button>
        <h2>{t('contacts.title')}</h2>
        <button className="btn text" onClick={() => fileInput.current?.click()}>
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
            if (file) void importFile(file);
            e.target.value = '';
          }}
        />
        <button className="btn tonal" onClick={() => setEditing('new')}>
          <UserPlus size={18} />
          <span className="desktop-only">{t('contacts.new')}</span>
        </button>
      </header>
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
              {filtered.map((c) => (
                <div key={c.id} className="contact-item" role="button" tabIndex={0} onClick={() => setEditing(c)} onKeyDown={(e) => e.key === 'Enter' && setEditing(c)}>
                  <Avatar name={c.name} seed={c.phones[0] ?? c.name} />
                  <div className="row-main">
                    <div className="row-title">{c.name}</div>
                    <div className="row-sub">{c.phones.map(formatPhone).join(' · ')}</div>
                  </div>
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && <ContactDialog contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
