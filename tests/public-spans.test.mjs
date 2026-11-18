// Public span/context API and host tool identity (ISSUE3 #3): frozen names,
// withSpan nesting and outcomes, begin/end handles, current context accessors
// with off-mode no-ops, undeclared names refused at the call, and the
// configureHost load-time phase rule with one-host conflict semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as trace from '../lib/writer-state.mjs';
import { registerVocabulary, registerOwnVocabulary } from '../lib/registry.mjs';
import * as api from '../lib/public-spans.mjs';
import { testDir, enableTrace, savedEnv } from './harness.mjs';

const rowsOf = dir => readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));

// A fragment package owning third-party span/point events for the API tests.
const fragment = (dir, name = 'frag') => {
  const pkgDir = join(dir, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'api-fragment', version: '0.2.0' }));
  const path = join(pkgDir, 'events.json');
  writeFileSync(path, JSON.stringify({ tool: 'api-fragment', events: {
    't.outer': { kind: 'span', fields: { where: 'x' } },
    't.inner': { kind: 'span', fields: { where: 'x' } },
    't.note': { kind: 'point', fields: { where: 'x' } },
  } }, null, 2));
  return path;
};

// Tracing on with the own vocabulary plus the fragment; returns {dir}.
const setup = (t, prefix) => {
  const dir = testDir(t, prefix);
  enableTrace(t, trace, dir);
  registerOwnVocabulary();
  registerVocabulary(fragment(testDir(t, `${prefix}frag-`)));
  return dir;
};

test('public names are exported and attached to the process handle', async t => {
  const index = await import('../lib/index.mjs');
  for (const name of ['configureHost', 'withSpan', 'beginSpan', 'endSpan',
    'currentSpan', 'currentTraceparent', 'currentRun']) {
    assert.equal(typeof api[name], 'function', `public-spans ${name}`);
    assert.equal(typeof index[name], 'function', `index ${name}`);
    assert.equal(typeof globalThis.__flattrace_pi?.[name], 'function', `global ${name}`);
  }
});

test('default host is flattrace-pi and configures the envelope', t => {
  const dir = setup(t, 'host-default-');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(trace.hostConfig(), { tool: 'flattrace-pi', version: pkg.version, configured: false });
  trace.ensureTrace({ sessionId: 's1' });
  const start = rowsOf(dir).find(r => r.event === 'run' && r.state === 'start');
  assert.equal(start.tool, 'flattrace-pi');
  assert.equal(start.tool_version, pkg.version);
  trace.shutdownTrace('ok', {}, false);
});

test('configureHost sets the envelope; same repeat is a no-op', t => {
  const dir = setup(t, 'host-set-');
  assert.deepEqual(api.configureHost({ tool: 'proof-host', toolVersion: '0.1.0' }),
    { tool: 'proof-host', toolVersion: '0.1.0' });
  assert.deepEqual(api.configureHost({ tool: 'proof-host', toolVersion: '0.1.0' }),
    { tool: 'proof-host', toolVersion: '0.1.0' }, 'reload-safe repeat');
  trace.ensureTrace({ sessionId: 's1' });
  const start = rowsOf(dir).find(r => r.event === 'run' && r.state === 'start');
  assert.equal(start.tool, 'proof-host');
  assert.equal(start.tool_version, '0.1.0');
  trace.shutdownTrace('ok', {}, false);
});

test('configureHost validates names and enforces load-time phase', t => {
  setup(t, 'host-phase-');
  assert.throws(() => api.configureHost({ tool: 'UPPER', toolVersion: '1' }), /lowercase-slug/);
  assert.throws(() => api.configureHost({ tool: '', toolVersion: '1' }), /lowercase-slug/);
  assert.throws(() => api.configureHost({ tool: 'has space', toolVersion: '1' }), /lowercase-slug/);
  assert.throws(() => api.configureHost({ tool: 'ok-host', toolVersion: '' }), /toolVersion/);
  assert.throws(() => api.configureHost({}), /lowercase-slug/);
  api.configureHost({ tool: 'first-host', toolVersion: '1.0.0' });
  trace.ensureTrace({ sessionId: 's1' });
  assert.deepEqual(api.configureHost({ tool: 'first-host', toolVersion: '1.0.0' }),
    { tool: 'first-host', toolVersion: '1.0.0' },
    'same-host repeat after open is a no-op: factories re-run per session with the previous run still open');
  assert.throws(() => api.configureHost({ tool: 'late-host', toolVersion: '1.0.0' }), /after the writer opened/);
  trace.resetTrace();
  enableTrace(t, trace, testDir(t, 'host-phase-2-'));
  registerOwnVocabulary();
  api.configureHost({ tool: 'first-host', toolVersion: '1.0.0' });
  assert.throws(() => api.configureHost({ tool: 'second-host', toolVersion: '1.0.0' }), /host conflict/);
  assert.throws(() => api.configureHost({ tool: 'first-host', toolVersion: '2.0.0' }), /host conflict/);
});

test('withSpan nests, reports outcomes, and routes points inside', async t => {
  const dir = setup(t, 'withspan-');
  trace.ensureTrace({ sessionId: 's1' });
  const outer = await api.withSpan('t.outer', { where: 'test' }, async handle => {
    assert.ok(handle && typeof handle === 'object', 'callback receives a handle');
    const ambient = api.currentSpan();
    assert.equal(ambient?.span, handle.span, 'currentSpan sees the withSpan span');
    const innerResult = await api.withSpan('t.inner', { where: 'nested' }, async inner => {
      assert.notEqual(inner.span, handle.span);
      assert.equal(api.currentSpan()?.span, inner.span, 'nesting tracks the innermost span');
      globalThis.__flattrace_pi.emitPoint('t.note', { where: 'inside' });
      return 'fine';
    });
    assert.equal(innerResult, 'fine', 'return value passes through');
    assert.equal(api.currentSpan()?.span, handle.span, 'outer context restored after the nested span');
    return 'ok';
  });
  assert.equal(outer, 'ok');
  trace.shutdownTrace('ok', {}, false);
  const rows = rowsOf(dir);
  const byEvent = name => rows.filter(r => r.event === name);
  const outerStart = byEvent('t.outer').find(r => r.state === 'start');
  const outerEnd = byEvent('t.outer').find(r => r.state === 'end');
  const innerStart = byEvent('t.inner').find(r => r.state === 'start');
  const innerEnd = byEvent('t.inner').find(r => r.state === 'end');
  assert.ok(outerStart && outerEnd && innerStart && innerEnd);
  assert.equal(outerEnd.outcome, 'ok', 'string return is the reported outcome');
  assert.equal(innerEnd.outcome, 'fine');
  assert.equal(innerStart.parent, outerStart.span, 'nested span parents to the outer span');
  const note = byEvent('t.note').find(r => r.state === 'point');
  assert.equal(note.span, innerStart.span, 'point written inside attaches to the inner span');
  assert.equal(note.parent, outerStart.span, 'the point row parents to the inner span\'s own parent');
});

test('withSpan outcome forms: object report, unreported unknown, throw is error', async t => {
  const dir = setup(t, 'withspan-out-');
  trace.ensureTrace({ sessionId: 's1' });
  await api.withSpan('t.outer', {}, async () => ({ outcome: 'weird', data: { extra: 1 } }));
  await api.withSpan('t.inner', {}, async () => {});
  await assert.rejects(api.withSpan('t.outer', {}, async () => { throw new Error('boom'); }), /boom/);
  trace.shutdownTrace('ok', {}, false);
  const ends = rowsOf(dir).filter(r => r.state === 'end' && r.event !== 'run');
  assert.deepEqual(ends.map(e => e.outcome).sort(), ['error', 'unknown', 'weird']);
  assert.equal(ends.find(e => e.outcome === 'weird').data.extra, 1, '{outcome, data} merges end data');
});

test('undeclared events are no-ops in every off state without vocabulary checks', async t => {
  const dir = setup(t, 'undeclared-off-');
  delete process.env.FLATTRACE_PI_STRICT;
  // An uncoercible name proves the vocabulary lookup is not reached at all.
  const name = { [Symbol.toPrimitive]() { throw new Error('vocabulary checked'); } };
  for (const mode of ['unset', 'empty', 'level0', 'disabled', 'closed']) {
    trace.resetTrace();
    process.env.FLATTRACE_DIR = dir;
    delete process.env.FLATTRACE_LEVEL;
    if (mode === 'unset') delete process.env.FLATTRACE_DIR;
    if (mode === 'empty') process.env.FLATTRACE_DIR = '';
    if (mode === 'level0') process.env.FLATTRACE_LEVEL = '0';
    if (mode === 'disabled') {
      process.env.FLATTRACE_TRACEPARENT = 'malformed';
      assert.equal(trace.ensureTrace(), null);
      delete process.env.FLATTRACE_TRACEPARENT;
    }
    if (mode === 'closed') trace.shutdownTrace();
    for (const event of ['no.such.event', name]) {
      assert.equal(api.beginSpan(event), null, mode);
      assert.equal(globalThis.__flattrace_pi.emitPoint(event), null, mode);
      assert.equal(api.withSpan(event, handle => { assert.equal(handle, null); return 42; }), 42);
    }
  }
  assert.deepEqual(readdirSync(dir), [], 'no trace file');
});

test('undeclared recording-on events diagnose once per event/api/run and produce valid traces', async t => {
  const dir = setup(t, 'undeclared-on-');
  delete process.env.FLATTRACE_PI_STRICT;
  // No fragment events are emitted: check with the own vocabulary alone.
  trace.resetTrace();
  registerOwnVocabulary();
  trace.ensureTrace({ sessionId: 's1' });
  const invoke = event => {
    assert.equal(api.beginSpan(event), null);
    assert.equal(globalThis.__flattrace_pi.emitPoint(event), null);
    const value = {};
    assert.equal(api.withSpan(event, handle => { assert.equal(handle, null); return value; }), value);
  };
  invoke('no.such.event');
  invoke('no.such.event');
  const reloaded = await import('../lib/registry.mjs?undeclared-reload=1');
  assert.equal(reloaded.emitPoint('no.such.event'), null, 'same-run dedup survives re-evaluation');
  invoke('another.missing');
  invoke('toString');
  invoke('constructor');
  trace.rotateTrace({ sessionId: 's2' });
  invoke('no.such.event');
  invoke('no.such.event');
  trace.shutdownTrace();
  const rows = rowsOf(dir);
  assert.ok(rows.every(r => !['no.such.event', 'another.missing', 'toString', 'constructor'].includes(r.event)));
  const diagnostics = rows.filter(r => r.event === 'pi.trace.undeclared');
  assert.equal(diagnostics.length, 15);
  for (const run of new Set(diagnostics.map(r => r.run))) {
    for (const event of new Set(diagnostics.filter(r => r.run === run).map(r => r.data.event))) {
      assert.deepEqual(diagnostics.filter(r => r.run === run && r.data.event === event)
        .map(r => r.data.api).sort(), ['beginSpan', 'emitPoint', 'withSpan']);
    }
  }
  const { spawnSync } = await import('node:child_process');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const result = spawnSync(process.env.FLATTRACE_PYTHON ?? 'python3',
      ['-m', 'flattrace', 'check', join(dir, file), '--events',
        new URL('../flattrace-events.json', import.meta.url).pathname], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

for (const on of [false, true]) {
  test(`strict undeclared errors with recording ${on ? 'on' : 'off'}`, t => {
    setup(t, 'undeclared-strict-');
    process.env.FLATTRACE_PI_STRICT = '1';
    if (on) trace.ensureTrace();
    else delete process.env.FLATTRACE_DIR;
    assert.throws(() => api.beginSpan('no.such.event'), /not declared by any registered vocabulary/);
    assert.throws(() => globalThis.__flattrace_pi.emitPoint('no.such.event'), /not declared by any registered vocabulary/);
    assert.throws(() => api.withSpan('no.such.event', () => assert.fail('must not run')), /not declared by any registered vocabulary/);
    trace.shutdownTrace();
  });
}

test('only exact strict value 1 enables errors', t => {
  const dir = setup(t, 'undeclared-strict-values-');
  trace.ensureTrace();
  for (const value of ['', '0', 'true', '01', ' 1', '1 ']) {
    process.env.FLATTRACE_PI_STRICT = value;
    assert.equal(api.beginSpan('no.such.event'), null);
  }
  trace.shutdownTrace();
  assert.equal(rowsOf(dir).filter(r => r.event === 'pi.trace.undeclared').length, 1);
});

for (const on of [false, true]) {
  test(`undeclared withSpan preserves sync and async values/throws when ${on ? 'on' : 'off'}`, async t => {
    setup(t, 'undeclared-withspan-');
    delete process.env.FLATTRACE_PI_STRICT;
    if (on) trace.ensureTrace();
    else delete process.env.FLATTRACE_DIR;
    const value = {}, error = new Error('callback failure');
    assert.equal(api.withSpan('no.such.event', () => value), value);
    const promise = Promise.resolve(value);
    assert.equal(api.withSpan('no.such.event', () => promise), promise);
    assert.throws(() => api.withSpan('no.such.event', () => { throw error; }), e => e === error);
    await assert.rejects(api.withSpan('no.such.event', async () => { throw error; }), e => e === error);
    assert.throws(() => api.beginSpan('no.such.event', {}, { parent: 'foreign' }), /span handle/);
    assert.throws(() => api.withSpan('no.such.event', null, null), /needs a function/);
    trace.shutdownTrace();
  });
}

test('off mode is a no-op that runs fn and returns nulls', async t => {
  savedEnv(t);
  for (const key of ['FLATTRACE_DIR', 'FLATTRACE_TRACEPARENT', 'FLATTRACE_LEVEL']) delete process.env[key];
  trace.resetTrace();
  t.after(() => trace.resetTrace());
  registerOwnVocabulary();
  assert.equal(trace.traceEnabled(), false);
  assert.equal(api.beginSpan('pi.agent', {}), null);
  assert.equal(await api.withSpan('pi.agent', {}, async handle => {
    assert.equal(handle, null, 'off-mode callback gets a null handle');
    return 42;
  }), 42);
  assert.equal(api.endSpan(null, 'ok'), null);
  assert.equal(api.currentSpan(), null);
  assert.equal(api.currentTraceparent(), null);
  assert.equal(api.currentRun(), null);
});

test('begin/end handles validate; ends are safe on drained and closed runs', async t => {
  const dir = setup(t, 'handles-');
  trace.ensureTrace({ sessionId: 's1' });
  const handle = api.beginSpan('t.outer', { where: 'h' });
  assert.ok(handle && typeof handle.span === 'string');
  assert.equal(api.currentSpan()?.span, handle.span);
  assert.equal(typeof api.currentTraceparent(), 'string');
  assert.match(api.currentTraceparent(), /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  assert.deepEqual(api.currentRun(), { trace: trace.currentWriter().trace, run: trace.currentWriter().run });
  assert.throws(() => api.endSpan('raw-id', 'ok'), /span handle/);
  assert.throws(() => api.endSpan(handle), /string outcome/);
  assert.throws(() => api.endSpan(handle, ''), /string outcome/);
  assert.throws(() => api.beginSpan('t.outer', {}, { parent: 'raw-id' }), /span handle/);
  const rootChild = api.beginSpan('t.inner', {}, { parent: null });
  assert.ok(rootChild, 'null parent attaches a detached span');
  api.endSpan(rootChild, 'ok');
  // Drain: the old run takes the late end, the new run stays clean.
  const open = api.beginSpan('t.outer', { where: 'drain' });
  const firstRun = trace.currentWriter().run;
  trace.rotateTrace({ sessionId: 's2', previousSessionId: 's1' });
  assert.ok(typeof api.endSpan(open, 'ok') === 'number', 'late end on a drained run is safe');
  assert.ok(typeof api.endSpan(handle, 'ok') === 'number', 'ending after rotation routes to the owning run');
  trace.shutdownTrace('ok', {}, false);
  assert.equal(api.endSpan(open, 'ok'), null, 'ending on a closed run never throws');
  const rows = rowsOf(dir);
  const drainedEnds = rows.filter(r => r.run === firstRun && r.event === 't.outer' && r.state === 'end');
  assert.ok(drainedEnds.length >= 2 && drainedEnds.every(r => r.outcome === 'ok'),
    'both late ends landed in the drained run with their reported outcomes');
});
