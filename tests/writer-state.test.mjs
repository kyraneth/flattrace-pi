// Writer singleton contracts: off switch, same-version reuse, rotation links,
// quit cancellation, conflicting registration refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as trace from '../lib/writer-state.mjs';
import { testDir, savedEnv } from './harness.mjs';

const rows = dir => readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f =>
  readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const files = dir => readdirSync(dir).filter(f => f.endsWith('.jsonl'));

test('off: unset DIR and level 0 perform no I/O, open no writer, start no span', t => {
  const saved = savedEnv(t);
  for (const [label, env] of [['unset', {}], ['empty', { FLATTRACE_DIR: '' }]]) {
    for (const k of ['FLATTRACE_DIR', 'FLATTRACE_LEVEL', 'FLATTRACE_TRACEPARENT']) delete process.env[k];
    Object.assign(process.env, env);
    trace.resetTrace();
    assert.equal(trace.traceEnabled(), false, label);
    assert.equal(trace.ensureTrace({}), null, label);
    assert.equal(trace.currentWriter(), null, label);
    assert.equal(trace.startSpan('pi.agent'), null, label);
  }
  const dir = testDir(t, 'ws-off-');
  process.env.FLATTRACE_DIR = dir;
  process.env.FLATTRACE_LEVEL = '0';
  trace.resetTrace();
  assert.equal(trace.traceEnabled(), false);
  assert.equal(trace.ensureTrace({}), null);
  assert.deepEqual(files(dir), []);
  trace.resetTrace();
  process.env = saved;
});

test('same-version second evaluation reuses the writer; conflicting slot throws', async t => {
  const dir = testDir(t, 'ws-reuse-');
  savedEnv(t);
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_LEVEL;
  delete process.env.FLATTRACE_TRACEPARENT;
  trace.resetTrace();
  const first = trace.ensureTrace({ sessionId: 's1' });
  assert.ok(first);
  assert.equal(trace.ensureTrace({ sessionId: 's1' }), first, 'same run reused');
  assert.deepEqual(files(dir).length, 1);
  // A second evaluation of the same version reuses the slot.
  const again = await import('../lib/writer-state.mjs?reuse=1');
  assert.equal(again.traceEnabled, trace.traceEnabled, 'same functions, same shared state');
  assert.equal(again.currentWriter(), first, 'reused writer, no second file');
  assert.deepEqual(files(dir).length, 1);
  // A conflicting occupant reports a conflict and opens no second writer.
  const slot = Symbol.for('flattrace.pi.process');
  const held = globalThis[slot];
  globalThis[slot] = { abi: 999, tool: 'flattrace-pi', version: '9.9.9' };
  try {
    await assert.rejects(import('../lib/writer-state.mjs?conflict=1'), error =>
      error.message.includes(`9.9.9 conflicts with ${trace.RECORDER_VERSION}`));
  } finally {
    globalThis[slot] = held;
  }
  trace.resetTrace();
});

test('rotation opens a linked run file; old run drains then closes', async t => {
  const dir = testDir(t, 'ws-rotate-');
  savedEnv(t);
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_LEVEL;
  delete process.env.FLATTRACE_TRACEPARENT;
  trace.resetTrace();
  const { registerOwnVocabulary } = await import('../lib/registry.mjs');
  registerOwnVocabulary();
  const first = trace.ensureTrace({ sessionId: 's1' });
  assert.ok(first);
  const openSpan = trace.startSpan('pi.agent', { sessionId: 's1' });
  assert.ok(openSpan);
  const { writer: second, previous, previousRun } = trace.rotateTrace({ sessionId: 's2', previousSessionId: 's1' });
  assert.ok(second);
  assert.equal(previous, first);
  assert.deepEqual(previousRun, { trace: first.trace, run: first.run });
  assert.notEqual(second.run, first.run);
  assert.equal(second.trace, first.trace, 'same process trace');
  assert.deepEqual(files(dir).length, 2, 'two files open only during drain');
  // New spans route to the new run; the old run takes none. An explicit
  // parent from the drained run falls back to the new root, never to a
  // foreign run.
  const before = trace.startSpan('pi.turn', { sessionId: 's2' });
  assert.ok(before);
  trace.endSpan(before, 'ok');
  const fallback = trace.startSpan('pi.late', {}, openSpan);
  assert.ok(fallback, 'stale parent falls back to the active root');
  trace.endSpan(fallback, 'ok');
  // Draining the old run's last span closes it with a paired run end.
  trace.endSpan(openSpan, 'ok');
  assert.deepEqual(files(dir).length, 2, 'old file stays, now closed');
  await new Promise(resolve => setTimeout(resolve, 50));
  const quit = trace.shutdownTrace('ok', { summary: 'test' }, true);
  assert.ok(quit);
  const secondRows = rows(dir).filter(r => r.run === second.run);
  const secondStart = secondRows.find(r => r.event === 'run' && r.state === 'start');
  assert.deepEqual(secondStart.data.links, [{ relation: 'continues_process', trace: first.trace, run: first.run }]);
  assert.ok(Array.isArray(secondStart.data.vocabularies) && secondStart.data.vocabularies.length >= 1);
  const firstRows = rows(dir).filter(r => r.run === first.run);
  assert.ok(firstRows.some(r => r.event === 'run' && r.state === 'end'), 'drained run closed once its spans ended');
  const allRows = rows(dir);
  assert.ok(allRows.filter(r => r.data?.sessionId === 's2').every(r => r.run === second.run),
    'post-rotation spans land in the new run, never the draining one');
  trace.resetTrace();
});

test('quit ends open spans cancelled and closes with a count', t => {
  const dir = testDir(t, 'ws-quit-');
  savedEnv(t);
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_LEVEL;
  delete process.env.FLATTRACE_TRACEPARENT;
  trace.resetTrace();
  const writer = trace.ensureTrace({ sessionId: 's1' });
  const a = trace.startSpan('pi.agent', {});
  const b = trace.startSpan('pi.turn', {}, a);
  assert.ok(a && b);
  const closed = trace.shutdownTrace('ok', { summary: null }, true);
  assert.equal(closed.run, writer.run);
  const all = rows(dir);
  const ends = new Map(all.filter(r => r.state === 'end').map(r => [r.span, r]));
  assert.equal(ends.get(a).outcome, 'cancelled');
  assert.equal(ends.get(b).outcome, 'cancelled');
  const runEnd = all.find(r => r.event === 'run' && r.state === 'end');
  assert.equal(runEnd.data.cancelledAtQuit, 2);
  trace.resetTrace();
});

test('disabled sink latches: malformed inherited context warns once and stays null', t => {
  savedEnv(t);
  const dir = testDir(t, 'ws-sink-');
  process.env.FLATTRACE_DIR = dir;
  process.env.FLATTRACE_TRACEPARENT = 'not-a-traceparent';
  delete process.env.FLATTRACE_LEVEL;
  trace.resetTrace();
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    assert.equal(trace.ensureTrace({ sessionId: 's1' }), null);
    assert.equal(trace.ensureTrace({ sessionId: 's1' }), null, 'latched, no retry');
  } finally {
    console.error = original;
  }
  assert.ok(errors.length >= 1, 'one warning');
  assert.equal(trace.currentWriter(), null);
  trace.resetTrace();
  delete process.env.FLATTRACE_TRACEPARENT;
});
