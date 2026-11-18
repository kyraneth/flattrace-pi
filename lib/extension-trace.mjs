// The recorder owns all measuring. Entries carry only local lazy dispatchers
// and a public-bus handshake at native activation, so loading before other
// extensions is safe.
import { performance } from 'node:perf_hooks';
import { distribution } from './trace-metrics.mjs';
import { createInventory } from './trace-inventory.mjs';

export const OPT_IN_CHANNEL = 'flattrace-pi:trace-extension';

const surfaces = { on: 'on', registerTool: 'tool', registerCommand: 'command',
  registerShortcut: 'shortcut', registerMessageRenderer: 'message', registerEntryRenderer: 'entry' };
const eventName = meta => meta.surface === 'on' ? meta.event : `${meta.surface}.${meta.slot}:${meta.event}`;
function nativeTool(meta, args) {
  if (meta.surface === 'on') return { id: args[0]?.toolCallId, active: true };
  if (meta.surface !== 'tool') return { id: null, active: false };
  if (meta.slot === 'execute') return { id: args[0], active: true };
  if (meta.slot === 'renderCall') return { id: args[2]?.toolCallId,
    active: args[2]?.executionStarted === true && args[2]?.durationMs === undefined };
  if (meta.slot === 'renderResult') return { id: args[3]?.toolCallId,
    active: args[1]?.isPartial === true };
  return { id: null, active: false };
}

export function extensionTracing(pi, trace, state, toolSpanFor, currentWorkSpan) {
  // New factory runtime, not new process. Remove stale derived registrations,
  // but retain process accounting and real unfinished execution lifetimes.
  state.extensions.clear(); state.toolInventory.clear(); state.lastInventory = null;
  const collected = createInventory(pi, trace, state);
  const descriptorFor = (api, name, version, source) => {
    if (typeof name !== 'string' || !name.length) return null;
    const previous = state.extensions.get(name);
    if (previous?.api === api) return previous;
    try { version = typeof version === 'function' ? version() : version; } catch { version = null; }
    const descriptor = { api, name, version: typeof version === 'string' ? version : null,
      source: collected.sourcePath(source), sessionId: null, armed: false };
    state.extensions.set(name, descriptor); return descriptor;
  };
  const invoke = (descriptor, meta, target, self, args) => {
    if (!trace.traceEnabled()) return target.apply(self, args);
    let begun, toolCallId, toolSpanId, parentSpanId;
    try {
      begun = performance.now(); const native = nativeTool(meta, args);
      toolCallId = typeof native.id === 'string' ? native.id : null;
      toolSpanId = native.active && toolCallId !== null ? toolSpanFor(toolCallId) : null;
      parentSpanId = toolSpanId ?? currentWorkSpan();
    } catch { return target.apply(self, args); }
    let recorded = false, invoked = false;
    const record = error => {
      if (recorded) return; recorded = true;
      try {
        const event = eventName(meta), handler = meta.handler;
        const key = JSON.stringify([descriptor.name, descriptor.version, event, handler, toolSpanId, toolCallId]);
        let row = state.extStats.get(key);
        if (!row) {
          row = { extension: descriptor.name, version: descriptor.version, event, handler,
            toolSpanId, toolCallId, attribution: toolSpanId ? 'active_native_tool_call_id'
              : toolCallId !== null ? 'native_tool_id_without_active_span' : 'current_context', samples: [], errors: 0 };
          state.extStats.set(key, row);
        }
        row.samples.push(performance.now() - begun); if (error) row.errors++;
      } catch { /* metadata never changes product returns/errors */ }
    };
    let result;
    try {
      result = trace.withTraceContext(parentSpanId, () => { invoked = true; return target.apply(self, args); });
    } catch (error) {
      if (!invoked) return target.apply(self, args);
      record(true); throw error;
    }
    if (result && typeof result.then === 'function') return Promise.resolve(result).then(
      value => { record(false); return value; }, error => { record(true); throw error; });
    record(false); return result;
  };
  const accept = request => {
    if (!trace.traceEnabled() || !request?.api || typeof request.arm !== 'function') return;
    const descriptor = descriptorFor(request.api, request.name, request.version, request.source);
    if (!descriptor) return;
    request.arm((meta, target, self, args) => invoke(descriptor, meta, target, self, args));
  };
  const instrument = (api, name, version, source) => {
    if (!trace.traceEnabled()) return api;
    const descriptor = descriptorFor(api, name, version, source); if (!descriptor) return api;
    let ordinal = 0;
    const wrap = (surface, event, slot, target) => {
      const meta = { surface, event, slot, handler: `${target.name || 'anonymous'}#${ordinal++}` };
      return function (...args) { return invoke(descriptor, meta, target, this, args); };
    };
    const facade = { ...api };
    for (const [method, surface] of Object.entries(surfaces)) {
      if (typeof api[method] !== 'function') continue;
      facade[method] = (...args) => {
        const event = typeof args[0] === 'string' ? args[0] : args[0]?.name ?? method;
        return api[method](...args.map((value, index) => {
          if (typeof value === 'function') return wrap(surface, event, String(index), value);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
          return Object.fromEntries(Object.entries(value).map(([slot, field]) => [slot,
            typeof field === 'function' ? wrap(surface, event, slot, field) : field]));
        }));
    };
    }
    if (typeof api.events?.on === 'function') facade.events = { ...api.events,
      on: (channel, handler) => api.events.on(channel, wrap('bus', channel, 'handler', handler)) };
    return facade;
  };
  const disarm = () => {};
  const flush = (span, data = {}) => {
    if (!state.extStats.size) return;
    const handlers = [...state.extStats.values()].map(({ samples, ...row }) => ({ ...row, took_ms: distribution(samples) }));
    trace.currentWriter()?.point('pi.ext', { partial: data.partial ?? false,
      nominalWindowMs: null, boundary: data.boundary ?? null, handlers,
      scope: 'Own opted-in callbacks completed since prior flush at an explicit lifecycle boundary (session_start, agent_settled, session_shutdown). Full async wall residence, not exclusive CPU or elapsed sum; straddlers credited at completion. Later render methods, non-opted handlers and recorder observers are outside timing coverage.' }, span);
    state.extStats.clear();
  };
  return { instrument, accept, disarm, inventory: collected.inventory, emitInventory: collected.emitInventory, flush };
}
