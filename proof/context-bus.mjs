// Independent implementation of the public handshake; no recorder imports.
import { probe } from './context-probe-tool.mjs';
export default function (pi) {
  let invoke = null;
  let armed = false;
  const announce = (sessionId, activate) => {
    pi.events.emit('flattrace-pi:trace-extension', {
      api: pi, name: 'context-bus', version: '1.0.0', source: import.meta.url,
      sessionId, activate, arm: hook => {
        if (typeof hook === 'function') { invoke = hook; armed = true; }
      },
    });
  };
  announce(null, false);
  const marker = (_event, ctx) => announce(ctx.sessionManager.getSessionId(), true);
  pi.on('session_start', marker);
  pi.on('before_agent_start', marker);
  const tool = probe('probe_bus', () => ({ armed }));
  const target = tool.execute;
  const site = { surface: 'tool', event: 'probe_bus', slot: 'execute', handler: 'execute#0' };
  tool.execute = function (...args) {
    return invoke ? invoke(site, target, this, args) : target.apply(this, args);
  };
  pi.registerTool(tool);
}
