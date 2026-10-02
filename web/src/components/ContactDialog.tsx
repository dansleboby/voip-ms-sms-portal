import { useState, type FormEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { errorText, t } from '../i18n';
import { loadContacts, loadConversations } from '../store';
import { Dialog } from './ui';
import { formatPhone, normalizePhone } from '../../../shared/phone';
import type { ContactDto } from '../../../shared/types';

export function ContactDialog({
  contact,
  initialPhone,
  onClose,
}: {
  contact: ContactDto | null;
  initialPhone?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? '');
  const [phones, setPhones] = useState<string[]>(
    contact?.phones.map(formatPhone) ?? (initialPhone ? [formatPhone(initialPhone)] : ['']),
  );
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (force = false) => {
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      phones: phones.map(normalizePhone).filter(Boolean),
      notes: notes.trim() || null,
      force,
    };
    try {
      if (contact) await api.updateContact(contact.id, payload);
      else await api.createContact(payload);
      await Promise.all([loadContacts(), loadConversations()]);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'phone_taken') {
        const list = (err.body.phones as string[]).map(formatPhone).join(', ');
        if (window.confirm(t('contacts.phoneTaken', { phones: list }))) return save(true);
      } else if (err instanceof ApiError && err.code === 'invalid_phone') {
        setError(t('contacts.invalidPhone', { phones: (err.body.phones as string[]).join(', ') }));
      } else {
        setError(err instanceof ApiError ? errorText(err.code) : t('error.offline'));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!contact || !window.confirm(t('contacts.deleteConfirm', { name: contact.name }))) return;
    await api.deleteContact(contact.id);
    await Promise.all([loadContacts(), loadConversations()]);
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  return (
    <Dialog title={contact ? t('contacts.edit') : t('contacts.new')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="field">
          <span>{t('contacts.name')}</span>
          <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>{t('contacts.phones')}</span>
          {phones.map((phone, i) => (
            <div key={i} style={{ display: 'flex', gap: 4 }}>
              <input
                className="input"
                inputMode="tel"
                aria-label={`${t('contacts.phones')} ${i + 1}`}
                value={phone}
                onChange={(e) => setPhones((list) => list.map((p, j) => (j === i ? e.target.value : p)))}
              />
              {phones.length > 1 && (
                <button type="button" className="icon-btn" aria-label={t('composer.remove')} onClick={() => setPhones((l) => l.filter((_, j) => j !== i))}>
                  <X size={18} />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn text small" style={{ alignSelf: 'flex-start' }} onClick={() => setPhones((l) => [...l, ''])}>
            <Plus size={16} />
            {t('contacts.addPhone')}
          </button>
        </div>
        <label className="field">
          <span>{t('contacts.notes')}</span>
          <textarea className="input" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          {contact && (
            <button type="button" className="btn danger" onClick={remove}>
              <Trash2 size={18} />
              {t('common.delete')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy || !name.trim() || !phones.some((p) => normalizePhone(p))}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
