// Shared two-party barrier proves that each pair overlaps across an async tick.
import { appendFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { Type } from 'typebox';

export function probe(tool, extra = () => ({})) {
  let arrivals = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  return { name: tool, label: tool, description: 'Read per-call trace context after overlapping execution',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
      await setImmediate();
      const api = globalThis.__flattrace_pi;
      const capture = { toolCallId, tool, traceparent: api?.currentTraceparent?.() ?? null,
        span: api?.currentSpan?.() ?? null, apiAbsent: api === undefined,
        arrivals, ...extra() };
      appendFileSync(process.env.PROOF_CAPTURES, JSON.stringify(capture) + '\n');
      return { content: [{ type: 'text', text: JSON.stringify(capture) }] };
    } };
}
