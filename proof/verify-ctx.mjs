// Verify actual captures, native tool results, and trace identities. Optional
// second argument selects a mutated captures file for wrong-parent negatives.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.env.PROOF_ROOT ?? '.');
const rows = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
try {
  const result = JSON.parse(readFileSync(join(root, 'result.json')));
  const { scenario } = result;
  assert(['recorder-first', 'recorder-last', 'off', 'no-recorder'].includes(scenario), 'known scenario');
  assert.equal(result.exit.code, 0, 'Pi exit');
  assert.equal(result.settled, true, 'Pi settled');
  const captures = rows(process.argv[3] ?? join(root, 'captures.jsonl'));
  const rpc = rows(join(root, 'rpc.jsonl'));
  const tools = ['plain', 'optin', 'bus'];
  const expectedIds = tools.flatMap(t => [1, 2].map(n => `ctx-${t}-${n}`));
  assert.deepEqual(captures.map(c => c.toolCallId).sort(), [...expectedIds].sort(), 'exact capture ids');
  const ends = rpc.filter(r => r.type === 'tool_execution_end');
  assert.deepEqual(ends.map(r => r.toolCallId).sort(), [...expectedIds].sort(), 'six native results');
  for (const c of captures) {
    assert.equal(c.arrivals, 2, `${c.toolCallId}: both pair calls started before capture`);
    assert.equal(c.tool, `probe_${c.toolCallId.split('-')[1]}`, 'tool identity');
    const end = ends.find(r => r.toolCallId === c.toolCallId);
    assert.equal(end.isError, false, `${c.toolCallId}: native success`);
    // A mutated capture must still be checked against the original native result.
    const original = JSON.parse(end.result.content.find(p => p.type === 'text').text);
    if (!process.argv[3]) assert.deepEqual(c, original, `${c.toolCallId}: result matches side file`);
  }
  const files = readdirSync(join(root, 'traces')).filter(f => f.endsWith('.jsonl'));
  if (scenario === 'off' || scenario === 'no-recorder') {
    assert.equal(files.length, 0, 'no trace file');
    for (const c of captures) {
      assert.equal(c.traceparent, null, `${c.toolCallId}: null traceparent`);
      assert.equal(c.span, null, `${c.toolCallId}: null span`);
      if (scenario === 'no-recorder') assert.equal(c.apiAbsent, true, 'global api undefined');
      if (c.tool === 'probe_bus') assert.equal(c.armed, false, 'bus never armed');
      if (scenario === 'off' && c.tool === 'probe_optin') assert.equal(c.rawApi, true, 'off returns raw API');
    }
    console.log(`PASS ${scenario}: six successful overlapping probes; null contexts; no trace; bus unarmed${scenario === 'off' ? '; opt-in API is raw' : '; global API undefined'}`);
  } else {
    assert.equal(files.length, 1, 'one trace');
    const trace = rows(join(root, 'traces', files[0]));
    const run = trace.find(r => r.event === 'run' && r.state === 'start');
    assert(run, 'run start');
    assert(trace.some(r => r.event === 'run' && r.state === 'end' && r.outcome === 'ok'), 'run closed ok');
    const starts = trace.filter(r => r.event === 'pi.tool' && r.state === 'start');
    assert.deepEqual(starts.map(r => r.data.toolCallId).sort(), [...expectedIds].sort(), 'six tool starts');
    const toolSpans = new Set(starts.map(r => r.span));
    for (const c of captures) {
      const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(c.traceparent ?? '');
      assert(tp, `${c.toolCallId}: valid traceparent`);
      assert.equal(tp[1], run.trace, `${c.toolCallId}: run trace`);
      const own = starts.find(r => r.data.toolCallId === c.toolCallId);
      if (c.tool === 'probe_plain') {
        assert(!toolSpans.has(c.span?.span ?? c.span), `${c.toolCallId}: currentSpan is not a tool`);
        assert(!toolSpans.has(tp[2]), `${c.toolCallId}: traceparent is not a tool`);
        const ambient = trace.find(r => r.span === tp[2] && r.state === 'start');
        assert(ambient, `${c.toolCallId}: observed ambient span exists`);
        console.log(`PASS ${c.toolCallId}: currentSpan=${JSON.stringify(c.span)}; traceparent span=${tp[2]} (${ambient.event === 'run' ? 'root' : ambient.event})`);
      } else {
        assert.equal(c.span?.span, own.span, `${c.toolCallId}: span mismatch with own pi.tool (expected ${own.span}, got ${JSON.stringify(c.span)})`);
        assert.equal(tp[2], own.span, `${c.toolCallId}: traceparent span mismatch with own pi.tool`);
        assert.equal(c.apiAbsent, false, 'API present');
        if (c.tool === 'probe_bus') assert.equal(c.armed, true, 'bus armed');
        console.log(`PASS ${c.toolCallId}: own pi.tool=${own.span}; traceparent trace=${tp[1]}`);
      }
    }
    for (const kind of ['optin', 'bus']) {
      const pair = captures.filter(c => c.tool === `probe_${kind}`);
      assert.notEqual(pair[0].span.span, pair[1].span.span, `${kind}: distinct pair spans`);
    }
    console.log(`PASS ${scenario}: six successful overlapping probes; per-call opt-in/bus isolation; distinct pair spans`);
  }
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
