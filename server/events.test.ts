import { afterEach, describe, expect, it } from 'vitest';
import { EventHub } from './events.js';

let hub: EventHub;
let now = 1_000_000;
const clock = () => now;

afterEach(() => hub.close());

describe('polling tabs', () => {
  it('get the events after their cursor, once', () => {
    hub = new EventHub(clock);
    const first = hub.poll(undefined, { tab: 'tab-00000001' });
    expect(first).toMatchObject({ events: [], reset: false });
    hub.broadcast({ type: 'dids' });
    hub.broadcast({ type: 'contacts' });
    const next = hub.poll(first.cursor, { tab: 'tab-00000001' });
    expect(next).toMatchObject({ events: [{ type: 'dids' }, { type: 'contacts' }], reset: false });
    expect(hub.poll(next.cursor, { tab: 'tab-00000001' })).toMatchObject({ events: [], reset: false, cursor: next.cursor });
  });

  it('start over after a restart, a malformed cursor or falling too far behind', () => {
    hub = new EventHub(clock);
    const before = new EventHub(clock).poll(undefined).cursor;
    expect(hub.poll(before).reset).toBe(true);
    const cursor = hub.poll(undefined).cursor;
    for (const bad of ['garbage', `${cursor}x`, cursor.replace(/\.\d+$/, '.'), cursor.replace(/\.\d+$/, '.99')]) {
      expect(hub.poll(bad).reset).toBe(true);
    }
    for (let i = 0; i < 500; i++) hub.broadcast({ type: 'reload' });
    expect(hub.poll(cursor)).toMatchObject({ reset: false });
    hub.broadcast({ type: 'reload' });
    expect(hub.poll(cursor)).toMatchObject({ events: [], reset: true });
  });

  it('count as open tabs until they stop polling', () => {
    hub = new EventHub(clock);
    const counts: number[] = [];
    hub.onClientCountChange((count) => counts.push(count));
    hub.poll(undefined, { tab: 'tab-00000001' });
    hub.poll(undefined, { tab: 'tab-00000001' });
    hub.poll(undefined, { tab: 'tab-00000002' });
    expect(hub.clientCount).toBe(2);
    now += 60_000;
    hub.poll(undefined, { tab: 'tab-00000002' });
    now += 60_000;
    hub.expire();
    expect(hub.clientCount).toBe(1);
    expect(counts).toEqual([1, 2, 1]);
  });

  it('hide push notifications on their device while visible and polling', () => {
    hub = new EventHub(clock);
    const tab = { device: 'device-0001', tab: 'tab-00000001', visible: true };
    hub.poll(undefined, tab);
    expect(hub.isOnScreen('device-0001')).toBe(true);
    expect(hub.isOnScreen('device-0002')).toBe(false);
    expect(hub.setVisibility(tab.tab, false)).toBe(true);
    expect(hub.isOnScreen('device-0001')).toBe(false);
    hub.poll(undefined, tab);
    expect(hub.isOnScreen('device-0001')).toBe(true);
    // A tab closed without a word stops counting as on screen long before it expires.
    now += 20_000;
    expect(hub.isOnScreen('device-0001')).toBe(false);
    expect(hub.clientCount).toBe(1);
  });
});
