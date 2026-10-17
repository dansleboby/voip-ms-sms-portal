import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '../i18n';
import { toastError } from '../store';
import { Dialog } from './ui';

/**
 * Asks before deleting a message or a whole conversation, and whether to
 * delete it at VoIP.ms too (off by default: VoIP.ms then keeps its copy).
 */
export function DeleteDialog({
  what,
  onConfirm,
  onClose,
}: {
  what: 'message' | 'conversation';
  onConfirm: (atVoipMs: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [atVoipMs, setAtVoipMs] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(atVoipMs);
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog title={t(what === 'message' ? 'delete.messageTitle' : 'delete.conversationTitle')} onClose={onClose}>
      <p className="dialog-text">{t(what === 'message' ? 'delete.messageBody' : 'delete.conversationBody')}</p>
      <label className="check-row">
        <input type="checkbox" checked={atVoipMs} onChange={(e) => setAtVoipMs(e.target.checked)} />
        <span>
          <span className="check-title">{t('delete.atVoipMs')}</span>
          <span className={atVoipMs ? 'check-hint error-text' : 'check-hint'}>{t(atVoipMs ? 'delete.atVoipMsOn' : 'delete.atVoipMsOff')}</span>
        </span>
      </label>
      <div className="dialog-actions">
        <span className="spacer" />
        <button type="button" className="btn text" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn danger-filled" onClick={() => void confirm()} disabled={busy}>
          {busy && <Loader2 size={18} className="spin" />}
          {t('common.delete')}
        </button>
      </div>
    </Dialog>
  );
}
