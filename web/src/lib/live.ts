import { api } from '../api';
import type { ServerEvent } from '../../../shared/types';

/**
 * Live updates from the server: each tab asks for the events since its
 * last poll every few seconds, which every host can serve (no stream is
 * held open).
 */

export interface LiveHandlers {
  /** Connected, for the first time or again after an error. */
  onOpen(): void;
  onEvent(event: ServerEvent): void;
  /** Connection lost; it keeps retrying on its own. */
  onError(): void;
  /** Some events were missed: reload everything. */
  onReset(): void;
}

export interface LiveTab {
  device: string;
  tab: string;
  visible: () => boolean;
}

/** Often enough that a reply or a send's outcome shows up within moments. */
const POLL_VISIBLE_MS = 3000;
/** The server keeps a hidden tab counted as open (faster VoIP.ms polling) while it polls at this pace. */
const POLL_HIDDEN_MS = 30_000;

/** Opens live updates; returns the function that closes them. */
export function openLiveUpdates(tab: LiveTab, handlers: LiveHandlers): () => void {
  let cursor: string | undefined;
  /** null until the first poll answers. */
  let healthy: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let closed = false;

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void poll(), ms);
  };

  const poll = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const result = await api.pollEvents({ after: cursor, device: tab.device, tab: tab.tab, visible: tab.visible() });
      if (closed) return;
      cursor = result.cursor;
      if (healthy !== true) {
        healthy = true;
        handlers.onOpen();
      }
      if (result.reset) handlers.onReset();
      for (const event of result.events) {
        try {
          handlers.onEvent(event);
        } catch {
          // One bad event must not hold back the others.
        }
      }
    } catch {
      if (closed) return;
      if (healthy !== false) {
        healthy = false;
        handlers.onError();
      }
    } finally {
      inFlight = false;
      if (!closed) schedule(tab.visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    }
  };

  // Coming back to the tab: catch up now rather than at the next slow poll.
  const onVisibility = () => {
    if (tab.visible()) schedule(0);
  };
  document.addEventListener('visibilitychange', onVisibility);
  schedule(0);

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
