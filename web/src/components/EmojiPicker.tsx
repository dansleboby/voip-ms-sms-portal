import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { t } from '../i18n';
import { EMOJI_CATEGORIES, recentEmojis, rememberEmoji, type EmojiCategory } from '../lib/emoji';

type Section = EmojiCategory | 'recent';

/**
 * Emoji panel opening above the message box. It stays open so several emoji
 * can be added in a row; Escape or a click outside closes it.
 */
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState(recentEmojis);
  const [current, setCurrent] = useState<Section>(recent.length ? 'recent' : 'smileys');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!panel.current?.contains(target) && !target.closest('[data-emoji-toggle]')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  const sections = useMemo(
    () => [
      ...(recent.length ? [{ id: 'recent' as const, icon: '', emojis: recent }] : []),
      ...EMOJI_CATEGORIES,
    ],
    // Recents are frozen while open so the grid does not jump under the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const jump = (id: Section) => {
    setCurrent(id);
    const el = grid.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && grid.current) grid.current.scrollTop = el.offsetTop - grid.current.offsetTop;
  };

  // Highlight the tab of the section being scrolled through.
  const onScroll = () => {
    const container = grid.current;
    if (!container) return;
    let active: Section = sections[0]!.id;
    for (const el of container.querySelectorAll<HTMLElement>('[data-section]')) {
      if (el.offsetTop - container.offsetTop <= container.scrollTop + 8) active = el.dataset.section as Section;
    }
    setCurrent(active);
  };

  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    setRecent(recentEmojis());
    onPick(emoji);
  };

  return (
    <div className="emoji-panel" ref={panel} role="dialog" aria-label={t('emoji.title')}>
      <div className="emoji-tabs" role="tablist">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={current === s.id}
            title={t(`emoji.${s.id}`)}
            aria-label={t(`emoji.${s.id}`)}
            onClick={() => jump(s.id)}
          >
            {s.id === 'recent' ? <Clock size={18} /> : s.icon}
          </button>
        ))}
      </div>
      <div className="emoji-grid" ref={grid} onScroll={onScroll}>
        {sections.map((s) => (
          <section key={s.id} data-section={s.id}>
            <h4>{t(`emoji.${s.id}`)}</h4>
            <div className="emoji-cells">
              {s.emojis.map((emoji) => (
                <button key={emoji} type="button" className="emoji-cell" onClick={() => pick(emoji)} aria-label={emoji}>
                  {emoji}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
