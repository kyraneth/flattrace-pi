import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { annotateCurrent, annotationId, registerDetector, registerGrader } from '../lib/index.mjs';
import * as trace from '../lib/writer-state.mjs';
import { registerOwnVocabulary, registerConventionsVocabulary } from '../lib/registry.mjs';
import { testDir, enableTrace } from './harness.mjs';

const detector = { name: 'direct', version: '1.0.0', kind: 'code' };
const labels = [{ label: 'observed', probability: null }];
function setup(t) {
  const dir = testDir(t, 'annotate-current-');
  enableTrace(t, trace, dir);
  registerOwnVocabulary();
  registerConventionsVocabulary();
  return { dir, writer: trace.ensureTrace({ sessionId: 'direct-test' }) };
}
const rows = writer => readFileSync(writer.path, 'utf8').trim().split('\n').map(JSON.parse);

test('annotateCurrent uses the active private writer and convention helper for labels', async t => {
  const { dir, writer } = setup(t);
  const target = { span: writer.root, entryId: 'e1' };
  const call = annotateCurrent({ detector, target, input_sha256: 'a'.repeat(64),
    labels, usage: { input: 3 }, cost: 0.25 });
  assert.deepEqual(await call.done, { status: 'ok', span: call.span, id: call.id });
  trace.shutdownTrace();
  assert.equal(readdirSync(dir).length, 1, 'no second writer');
  const occurrence = { ...target, trace: writer.trace, run: writer.run };
  assert.equal(call.id, annotationId(detector, occurrence));
  assert.deepEqual(target, { span: writer.root, entryId: 'e1' }, 'input not mutated');
  const point = rows(writer).find(r => r.event === 'annotation');
  assert.deepEqual(point.data, { target: occurrence, id: call.id, detector,
    label: 'observed', probability: null, input_sha256: 'a'.repeat(64) });
  assert.equal(point.span, call.span);
  const end = rows(writer).find(r => r.event === 'annotate' && r.state === 'end');
  assert.deepEqual(end.data.usage, { input: 3 });
  assert.equal(end.data.cost, 0.25);
});

test('annotateCurrent callback gets active identities and records a grader verdict', async t => {
  const { writer } = setup(t);
  const identity = { trace: writer.trace, run: writer.run };
  const call = globalThis.__flattrace_pi.annotateCurrent({ detector,
    target: identity, input_sha256: 'b'.repeat(64), usage: { input: 2 }, cost: 0.25,
    run: async context => {
      assert.deepEqual(context.target, identity);
      assert.equal(context.input_sha256, 'b'.repeat(64));
      return { correct: true, score: 1, usage: { input: 4 }, cost: 0.5 };
    } });
  assert.equal((await call.done).status, 'ok');
  trace.shutdownTrace();
  const point = rows(writer).find(r => r.event === 'verdict');
  assert.equal(point.data.trace, writer.trace);
  assert.equal(point.data.run, writer.run);
  const end = rows(writer).find(r => r.event === 'annotate' && r.state === 'end');
  assert.deepEqual(end.data.usage, { input: 4 });
  assert.equal(end.data.cost, 0.5);
});

test('annotateCurrent never dispatches registered detectors or graders', async t => {
  const dir = testDir(t, 'annotate-no-dispatch-');
  enableTrace(t, trace, dir);
  registerOwnVocabulary();
  registerConventionsVocabulary();
  let dispatched = 0;
  registerDetector({ name: 'other-detector', version: '1', kind: 'code', run: () => { dispatched++; } });
  registerGrader({ name: 'other-grader', version: '1', kind: 'code', run: () => { dispatched++; } });
  const writer = trace.ensureTrace();
  await annotateCurrent({ detector, labels }).done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched, 0);
  trace.shutdownTrace();
  assert.equal(rows(writer).filter(r => r.event === 'annotate' && r.state === 'start').length, 1);
});

test('annotateCurrent off or before session start is null, without callback or trace I/O', t => {
  const dir = testDir(t, 'annotate-off-');
  enableTrace(t, trace, join(dir, 'must-not-exist'));
  const options = { detector, run: () => assert.fail('off callback must not execute') };
  assert.equal(annotateCurrent(options), null, 'no active writer');
  process.env.FLATTRACE_LEVEL = '0';
  assert.equal(annotateCurrent(options), null);
  delete process.env.FLATTRACE_DIR;
  assert.equal(annotateCurrent(options), null);
  assert.equal(existsSync(join(dir, 'must-not-exist')), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('annotateCurrent respects level zero even with an already active writer', t => {
  const { writer } = setup(t);
  const before = readFileSync(writer.path);
  process.env.FLATTRACE_LEVEL = '0';
  assert.equal(annotateCurrent({ detector, labels }), null);
  assert.deepEqual(readFileSync(writer.path), before);
  trace.shutdownTrace();
});

test('annotateCurrent refuses foreign run and trace targets before writing or calling', t => {
  const { writer } = setup(t);
  const before = readFileSync(writer.path);
  for (const key of ['run', 'trace']) {
    assert.throws(() => annotateCurrent({ detector, target: { [key]: 'foreign' },
      run: () => assert.fail('foreign target callback') }), /target .* must name the active run/);
  }
  assert.deepEqual(readFileSync(writer.path), before);
  trace.shutdownTrace();
});

test('annotateCurrent rejects ambiguous or invalid inputs without trace writes', t => {
  const { writer } = setup(t);
  const before = readFileSync(writer.path);
  for (const options of [{}, { labels, run: () => ({ labels }) }, { labels: null },
    { run: null }, { labels, target: null }, { labels, target: [] }, { labels, detector: null }]) {
    assert.throws(() => annotateCurrent({ detector, ...options }), TypeError);
  }
  assert.deepEqual(readFileSync(writer.path), before);
  trace.shutdownTrace();
});
