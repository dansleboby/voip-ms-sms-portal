// The server, as if it were DEMO_NOW ("2026-09-29T21:30:00-04:00"): demo
// mode seeds its texts relative to now, so screenshots taken with it come
// out the same from one run to the next. Started by scripts/screenshots.ts;
// the other settings come from the environment, as for server/index.ts.

const RealDate = Date;
const offset = RealDate.parse(process.env.DEMO_NOW ?? '') - RealDate.now();
if (!Number.isFinite(offset)) throw new Error('Set DEMO_NOW, like 2026-09-29T21:30:00-04:00');
const now = () => RealDate.now() + offset;

// Date, with its clock moved; everything else about it is unchanged.
globalThis.Date = new Proxy(RealDate, {
  construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
  apply: () => new RealDate(now()).toString(),
  get: (target, key, receiver) => (key === 'now' ? now : Reflect.get(target, key, receiver)),
});

await import('../server/index.js');
