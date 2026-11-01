import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { toast, toastError } from '../store';
import { Switch } from './ui';
import { formatPhone } from '../../../shared/phone';
import type { DidDto } from '../../../shared/types';

export const DID_COLORS = ['#1a73e8', '#e8710a', '#188038', '#a142f4', '#d93025', '#007b83', '#c5221f', '#9334e6', '#b06000', '#5f6368'];

/**
 * Label, color and visibility of one number; every change is saved right
 * away. Turning on a number without SMS enables SMS for it in VoIP.ms. In
 * the Team mode, whether its users share their unread counts and archive.
 */
export function DidEditor({ did, team, onChange }: { did: DidDto; team?: boolean; onChange?: (did: DidDto) => void }) {
  const [label, setLabel] = useState(did.label ?? '');
  const [enabling, setEnabling] = useState(false);
  useEffect(() => setLabel(did.label ?? ''), [did.label]);
  const canEnable = !did.smsEnabled && did.smsAvailable;

  const enableSms = async () => {
    setEnabling(true);
    try {
      onChange?.(await api.enableSms(did.did));
      toast(t('settings.smsEnabledNow', { number: formatPhone(did.did) }));
    } catch (err) {
      toastError(err);
    } finally {
      setEnabling(false);
    }
  };

  const save = async (patch: Partial<Pick<DidDto, 'label' | 'color' | 'visible' | 'sharedState'>>) => {
    try {
      onChange?.(await api.updateDid(did.did, patch));
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className={`did-row${did.smsEnabled || canEnable ? '' : ' disabled'}`}>
      <span className={`rail-did${did.label ? '' : ' digits'}`} style={{ background: did.color }} aria-hidden="true">
        {(did.label || did.did.slice(0, 3)).slice(0, did.label ? 1 : 3).toUpperCase()}
      </span>
      <div className="row-main">
        <div className="row-title">{formatPhone(did.did)}</div>
        <div className="row-sub">
          {[did.description, !did.smsEnabled && t(did.smsAvailable ? 'settings.smsDisabled' : 'settings.smsUnavailable')].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Switch
        checked={did.visible}
        label={t('settings.visible')}
        // A number without SMS that is not shown has nothing to offer, unless SMS can be turned on.
        disabled={enabling || (!did.smsEnabled && !did.smsAvailable && !did.visible)}
        onChange={(visible) => void (visible && canEnable ? enableSms() : save({ visible }))}
      />
      {canEnable && (
        <div className="did-note">
          {enabling ? (
            <>
              <Loader2 size={16} className="spin" /> {t('settings.enablingSms')}
            </>
          ) : did.visible ? (
            <button type="button" className="btn text" onClick={() => void enableSms()}>
              {t('settings.enableSms')}
            </button>
          ) : (
            t('settings.enableSmsHint')
          )}
        </div>
      )}
      {did.smsEnabled && (
        <>
          <input
            className="input did-label-input"
            placeholder={t('settings.labelPlaceholder')}
            aria-label={t('settings.label')}
            maxLength={40}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== (did.label ?? '') && void save({ label: label || null })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <div className="swatches" role="group" aria-label={t('settings.color')}>
            {DID_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="swatch"
                style={{ background: color }}
                aria-pressed={did.color === color}
                aria-label={color}
                onClick={() => void save({ color })}
              />
            ))}
          </div>
          {team && (
            <div className="did-shared">
              <div className="row-main">
                <div className="row-title">{t('settings.sharedState')}</div>
                <div className="row-sub">{t(did.sharedState ? 'settings.sharedStateOn' : 'settings.sharedStateOff')}</div>
              </div>
              <Switch checked={did.sharedState} label={t('settings.sharedState')} onChange={(sharedState) => void save({ sharedState })} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
