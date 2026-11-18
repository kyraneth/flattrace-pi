// Opt-in facade for other recorder extensions: wrap your extension api so
// your own callbacks are timed (pi.ext) and your package identity is
// discovered (pi.inventory). Zero-cost when tracing is off: the original api
// is returned untouched and no version is resolved.
//
// const { traceOptIn } = await import('flattrace-pi/lib/opt-in.mjs');
// export default function (pi) {
//   pi = traceOptIn(pi, { name: 'your-package', version: '1.2.3', source: import.meta.url });
//   ...register tools/commands on pi as usual...
// }
//
// Or announce an already-wrapped api through the bus channel directly:
//
//   pi.events?.emit?.('flattrace-pi:trace-extension',
//     { api, name, version, source, activate: true, arm: hook => { invoke = hook; } });
export const OPT_IN_CHANNEL = 'flattrace-pi:trace-extension';

function off() {
  if (!process.env.FLATTRACE_DIR) return true;
  const level = (process.env.FLATTRACE_LEVEL ?? '').replace(/^[\p{White_Space}\x1c-\x1f]+|[\p{White_Space}\x1c-\x1f]+$/gu, '');
  // Exact canonical zero-level semantics; empty/BOM/invalid default to enabled.
  if (/^0+$/.test(level)) return true;
  return false;
}

export function traceOptIn(raw, meta) {
  if (!raw || off()) return raw;
  let invoke = null, ordinal = 0;
  const wrap = (surface, event, slot, target) => {
    const site = { surface, event, slot, handler: `${target.name || 'anonymous'}#${ordinal++}` };
    return function (...args) { return invoke ? invoke(site, target, this, args) : target.apply(this, args); };
  };
  const announce = (sessionId, activate) => {
    try {
      raw.events?.emit?.(OPT_IN_CHANNEL, { ...(meta ?? {}), api: raw, activate,
        arm: hook => { if (typeof hook === 'function') invoke = hook; }, sessionId });
    } catch { /* tracing fails open */ }
  };
  // A declaration supplies names/versions to the initial header but cannot
  // activate a failed factory. Dispatch-time markers prove native commitment.
  announce(null, false);
  const marker = (_event, ctx) => {
    try { announce(ctx.sessionManager.getSessionId(), true); } catch { /* fails open */ }
  };
  raw.on('session_start', marker);
  raw.on('before_agent_start', marker);
  const facade = { ...raw };
  const surfaces = { on: 'on', registerTool: 'tool', registerCommand: 'command',
    registerShortcut: 'shortcut', registerMessageRenderer: 'message', registerEntryRenderer: 'entry' };
  for (const [method, surface] of Object.entries(surfaces)) {
    if (typeof raw[method] !== 'function') continue;
    facade[method] = (...args) => {
      const event = typeof args[0] === 'string' ? args[0] : args[0]?.name ?? method;
      return raw[method](...args.map((value, index) => {
        if (typeof value === 'function') return wrap(surface, event, String(index), value);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).map(([slot, field]) => [slot,
          typeof field === 'function' ? wrap(surface, event, slot, field) : field]));
      }));
    };
  }
  if (typeof raw.events?.on === 'function') facade.events = { ...raw.events,
    on: (channel, handler) => raw.events.on(channel, wrap('bus', channel, 'handler', handler)) };
  return facade;
}
