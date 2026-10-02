import { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { toastError } from '../store';
import { Switch } from './ui';
import { formatPhone } from '../../../shared/phone';
import type { DidDto } from '../../../shared/types';

export const DID_COLORS = ['#1a73e8', '#e8710a', '#188038', '#a142f4', '#d93025', '#007b83', '#c5221f', '#9334e6', '#b06000', '#5f6368'];

/** Label, color and visibility of one number; every change is saved right away. */
export function DidEditor({ did, onChange }: { did: DidDto; onChange?: (did: DidDto) => void }) {
  const [label, setLabel] = useState(did.label ?? '');
  useEffect(() => setLabel(did.label ?? ''), [did.label]);

  const save = async (patch: Partial<Pick<DidDto, 'label' | 'color' | 'visible'>>) => {
    try {
      onChange?.(await api.updateDid(did.did, patch));
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className={`did-row${did.smsEnabled ? '' : ' disabled'}`}>
      <span className={`rail-did${did.label ? '' : ' digits'}`} style={{ background: did.color }} aria-hidden="true">
        {(did.label || did.did.slice(0, 3)).slice(0, did.label ? 1 : 3).toUpperCase()}
      </span>
      <div className="row-main">
        <div className="row-title">{formatPhone(did.did)}</div>
        <div className="row-sub">
          {did.description}
          {!did.smsEnabled && ` · ${t('settings.smsDisabled')}`}
        </div>
      </div>
      <Switch
        checked={did.visible}
        label={t('settings.visible')}
        onChange={(visible) => void save({ visible })}
      />
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
        </>
      )}
    </div>
  );
}
