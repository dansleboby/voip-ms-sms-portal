import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { User, X } from 'lucide-react';
import { avatarColor, formatAgo, formatDateTime, initials } from '../lib/format';
import { dismissToast, useStore } from '../store';
import { t } from '../i18n';
import { formatPhoneInput } from '../../../shared/phone';

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

/** The current time, refreshed every 15 s while the component is on screen. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "2 minutes ago", kept current while on screen; the exact time shows on hover. */
export function Ago({ at }: { at: number }) {
  const now = useNow();
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {formatAgo(at, Math.max(now, at))}
    </time>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/** Where the caret goes in `text` to come right after its `count`th digit. */
function afterDigits(text: string, count: number): number {
  if (count === 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]!) && ++seen === count) return i + 1;
  }
  return text.length;
}

/** A phone number field that formats North American numbers as they are typed: (514) 555-0100. */
export function PhoneInput({
  value,
  onChange,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    // Formatting adds characters: keep the caret after the same digit as before.
    if (caret.current !== null && ref.current === document.activeElement) ref.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <input
      {...rest}
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      value={value}
      onChange={(e) => {
        const typed = e.target.value;
        const formatted = formatPhoneInput(typed);
        const digitsBefore = typed.slice(0, e.target.selectionStart ?? typed.length).replace(/\D/g, '').length;
        caret.current = afterDigits(formatted, digitsBefore);
        onChange(formatted);
      }}
    />
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
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action!.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label={t('common.close')} onClick={() => dismissToast(toast.id)}>
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
