// Frozen API surface: the extension-point names other packages bind to, the
// envelope identity, and the opt-in channel. Renaming any of these breaks
// consumers; this test fails first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as trace from '../lib/writer-state.mjs';
import { harness, testDir, savedEnv } from './harness.mjs';

test('extension-point names are frozen', async t => {
  const registry = await import('../lib/registry.mjs');
  for (const name of ['registerVocabulary', 'registerConventionsVocabulary', 'flattraceConventionsPath', 'registerDetector', 'registerGrader', 'emitPoint']) {
    assert.equal(typeof registry[name], 'function', name);
  }
  const annotateMod = await import('../lib/annotate.mjs');
  assert.equal(typeof annotateMod.annotate, 'function', 'annotate');
  assert.equal(typeof annotateMod.annotationId, 'function', 'annotationId');
  const index = await import('../lib/index.mjs');
  assert.equal(typeof index.traceOptIn, 'function');
  const { OPT_IN_CHANNEL } = await import('../lib/extension-trace.mjs');
  assert.equal(OPT_IN_CHANNEL, 'flattrace-pi:trace-extension');
  assert.equal(typeof globalThis.__flattrace_pi?.registerVocabulary, 'function');
  assert.equal(typeof globalThis.__flattrace_pi?.registerConventionsVocabulary, 'function');
  assert.equal(typeof globalThis.__flattrace_pi?.registerDetector, 'function');
  assert.equal(typeof globalThis.__flattrace_pi?.registerGrader, 'function');
  assert.equal(typeof globalThis.__flattrace_pi?.emitPoint, 'function');
  assert.equal(typeof globalThis.__flattrace_pi?.annotate, 'function');
  assert.equal(typeof index.annotateCurrent, 'function');
  assert.equal(globalThis.__flattrace_pi?.annotateCurrent, index.annotateCurrent);
});

test('public span and host API names are frozen', async t => {
  const index = await import('../lib/index.mjs');
  await import('../lib/public-spans.mjs');
  for (const name of ['configureHost', 'withSpan', 'beginSpan', 'endSpan',
    'currentSpan', 'currentTraceparent', 'currentRun']) {
    assert.equal(typeof index[name], 'function', `index ${name}`);
    assert.equal(typeof globalThis.__flattrace_pi?.[name], 'function', `global ${name}`);
  }
});

test('envelope identity is flattrace-pi with the package version', async t => {
  const dir = testDir(t, 'api-env-');
  savedEnv(t);
  trace.resetTrace();
  t.after(() => trace.resetTrace());
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_LEVEL;
  delete process.env.FLATTRACE_TRACEPARENT;
  const { registerWorkTrace } = await import('../lib/work-trace.mjs');
  const { registerOwnVocabulary } = await import('../lib/registry.mjs');
  registerOwnVocabulary();
  const h = harness();
  registerWorkTrace(h.api, trace).attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_shutdown', { reason: 'quit' });
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(trace.RECORDER_TOOL, 'flattrace-pi');
  assert.equal(trace.RECORDER_VERSION, pkg.version);
  assert.equal(trace.TRACE_ENTRY, 'flattrace-pi/v1');
  const { readdirSync } = await import('node:fs');
  const first = readFileSync(`${dir}/${readdirSync(dir).find(f => f.endsWith('.jsonl'))}`, 'utf8').split('\n')[0];
  const row = JSON.parse(first);
  assert.equal(row.tool, 'flattrace-pi');
  assert.equal(row.tool_version, pkg.version);
  const vocab = JSON.parse(readFileSync(new URL('../flattrace-events.json', import.meta.url), 'utf8'));
  assert.equal(vocab.tool, 'flattrace-pi');
  assert.ok(!('annotate' in vocab.events) && !('annotation' in vocab.events) && !('verdict' in vocab.events),
    'convention names live in the dependency vocabulary, not here');
});

test('package manifest carries the pi extension entry and the supported harness range', async t => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./extensions/flattrace-pi.js']);
  assert.equal(pkg.peerDependencies['@earendil-works/pi-coding-agent'], '>=1.4.0 <2');
  assert.equal(pkg.dependencies.flattrace, '0.3.1');
  assert.equal(pkg.type, 'module');
});
