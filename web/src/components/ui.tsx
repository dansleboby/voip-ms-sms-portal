import { useEffect, useRef, type ReactNode } from 'react';
import { User, X } from 'lucide-react';
import { avatarColor, initials } from '../lib/format';
import { dismissToast, useStore } from '../store';
import { t } from '../i18n';

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="14" fill="var(--primary)" />
      <path
        d="M14 15.5h20a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H22l-6.2 4.6a.8.8 0 0 1-1.3-.6v-4A3.5 3.5 0 0 1 10.5 29V19a3.5 3.5 0 0 1 3.5-3.5Z"
        fill="var(--on-primary)"
      />
      <circle cx="18" cy="24" r="1.8" fill="var(--primary)" />
      <circle cx="24" cy="24" r="1.8" fill="var(--primary)" />
      <circle cx="30" cy="24" r="1.8" fill="var(--primary)" />
    </svg>
  );
}

export function Avatar({ name, seed, size }: { name: string; seed: string; size?: 'lg' }) {
  const letters = initials(name);
  return (
    <span className={`avatar${size === 'lg' ? ' lg' : ''}`} style={{ background: avatarColor(seed) }} aria-hidden="true">
      {letters ?? <User size={size === 'lg' ? 28 : 22} />}
    </span>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <div className="lightbox-bar">
        <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
          <X />
        </button>
      </div>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.text}</span>
          <button className="icon-btn" aria-label={t('common.close')} onClick={() => dismissToast(toast.id)}>
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
