// annotate() contracts: the single helper live dispatch and batch/late runs
// share. Shapes follow the flattrace convention (accepted 0.3.0 source,
// sibling docs/learning.md "Detectors, annotations, actions and changes" @
// e954cb8, machine-checked in schema/conventions-events.json):
// - annotate span data: {detector: {name, version, kind}, questions?,
//   input_sha256, usage, cost} (usage/cost null when unknown).
// - annotation point data: {target, id, detector, label, probability,
//   input_sha256} with optional supersedes. target: {trace, run, span?,
//   entryId?, t_from?, t_to?, seq?}. id is stable across re-labels.
// - a grader outcome settles as a verdict point with the convention keys
//   {correct, grader: {name, version, kind}, name, reason, reward, run,
//   score, span, trace}.
// The key-set assertions below pin that structure equality; the proof
// re-checks the same shapes in a live run and the union checker re-checks
// the declarations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Writer } from 'flattrace';
import { annotate, annotationId } from '../lib/annotate.mjs';

const detector = { name: 'shape', version: '1.0.0', kind: 'code' };

const scratch = t => {
  const root = mkdtempSync(join(tmpdir(), 'annotate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const openWriter = dir => new Writer(join(dir, 'batch.jsonl'), 'proof-batch', '0.1.0', {
  data: { command: 'batch', links: [{ relation: 'annotates', trace: 't'.repeat(32), run: 'r'.repeat(32) }] },
});
const rowsOf = dir => readFileSync(join(dir, 'batch.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);

test('ok labels: annotate span, one point per label, convention key sets', async t => {
  const dir = scratch(t);
  const writer = openWriter(dir);
  const target = { trace: writer.trace, run: writer.run, span: 's'.repeat(16), entryId: 'e1' };
  const call = annotate(writer, { detector, target, input_sha256: 'a'.repeat(64),
    chunk: { entryId: 'e1' },
    run: () => ({ labels: [{ label: 'seen', probability: 0.5 }, { label: 'maybe', probability: null }] }) });
  assert.match(call.span, /^[0-9a-f]{16}$/);
  assert.match(call.id, /^[0-9a-f]{64}$/);
  assert.equal(call.id, annotationId(detector, target), 'id is deterministic');
  const settled = await call.done;
  assert.deepEqual(settled, { status: 'ok', span: call.span, id: call.id });
  writer.close('ok', {});
  const rows = rowsOf(dir);
  const start = rows.find(r => r.event === 'annotate' && r.state === 'start');
  assert.deepEqual(Object.keys(start.data).sort(), ['detector', 'input_sha256']);
  assert.deepEqual(start.data.detector, detector);
  const end = rows.find(r => r.event === 'annotate' && r.state === 'end');
  assert.deepEqual(Object.keys(end.data).sort(), ['cost', 'detector', 'input_sha256', 'usage']);
  assert.equal(end.data.usage, null);
  assert.equal(end.data.cost, null);
  assert.equal(end.outcome, 'ok');
  const points = rows.filter(r => r.event === 'annotation');
  assert.equal(points.length, 2);
  for (const point of points) {
    assert.deepEqual(Object.keys(point.data).sort(),
      ['detector', 'id', 'input_sha256', 'label', 'probability', 'target']);
    assert.deepEqual(point.data.target, target);
    assert.deepEqual(point.data.detector, detector);
    assert.equal(point.data.id, call.id);
    assert.equal(point.span, call.span);
  }
  assert.deepEqual(points.map(p => [p.data.label, p.data.probability]), [['seen', 0.5], ['maybe', null]]);
});

test('questions ride the span; usage and cost land on the ok end', async t => {
  const dir = scratch(t);
  const writer = openWriter(dir);
  const target = { trace: writer.trace, run: writer.run };
  const questions = [{ ask: 'shaped?' }];
  const call = annotate(writer, { detector, target, input_sha256: null, chunk: null,
    questions, run: () => ({ labels: [], usage: { input: 1 }, cost: 0.5 }) });
  assert.deepEqual(await call.done, { status: 'ok', span: call.span, id: call.id });
  writer.close('ok', {});
  const rows = rowsOf(dir);
  assert.deepEqual(rows.find(r => r.event === 'annotate' && r.state === 'start').data.questions, questions);
  const end = rows.find(r => r.event === 'annotate' && r.state === 'end');
  assert.deepEqual(end.data.usage, { input: 1 });
  assert.equal(end.data.cost, 0.5);
  assert.equal(rows.filter(r => r.event === 'annotation').length, 0, 'no labels, no points');
});

test('refused, error and cancelled ends are honest', async t => {
  const dir = scratch(t);
  const writer = openWriter(dir);
  const target = () => ({ trace: writer.trace, run: writer.run });
  const refused = annotate(writer, { detector, target: target(), input_sha256: null,
    chunk: null, run: () => ({ refused: true, reason: 'not mine' }) });
  assert.deepEqual(await refused.done, { status: 'refused', span: refused.span, id: refused.id });
  const threw = annotate(writer, { detector, target: target(), input_sha256: null,
    chunk: null, run: () => { throw new Error('boom'); } });
  assert.deepEqual((await threw.done).status, 'error');
  const empty = annotate(writer, { detector, target: target(), input_sha256: null,
    chunk: null, run: () => ({}) });
  assert.deepEqual((await empty.done).status, 'error');
  const cancelled = annotate(writer, { detector, target: target(), input_sha256: null,
    chunk: null, run: () => ({ cancelled: true }) });
  assert.deepEqual(await cancelled.done, { status: 'cancelled', span: cancelled.span, id: cancelled.id });
  writer.close('ok', {});
  const rows = rowsOf(dir);
  const bySpan = span => rows.find(r => r.event === 'annotate' && r.state === 'end' && r.span === span);
  assert.equal(bySpan(refused.span).outcome, 'refused');
  assert.equal(bySpan(refused.span).data.refusalReason, 'not mine');
  assert.equal(bySpan(threw.span).outcome, 'error');
  assert.equal(bySpan(threw.span).error.kind, 'detector.error');
  assert.equal(bySpan(empty.span).outcome, 'error');
  assert.equal(bySpan(cancelled.span).outcome, 'cancelled');
});

test('supersedes names the replaced annotation explicitly', async t => {
  const dir = scratch(t);
  const writer = openWriter(dir);
  const target = { trace: writer.trace, run: writer.run, entryId: 'e9' };
  const first = annotate(writer, { detector, target, input_sha256: '0'.repeat(64),
    chunk: null, run: () => ({ labels: [{ label: 'v1', probability: null }] }) });
  await first.done;
  const relabel = annotate(writer, { detector: { ...detector, version: '1.1.0' }, target,
    input_sha256: '0'.repeat(64), chunk: null, supersedes: first.id,
    run: () => ({ labels: [{ label: 'v2', probability: null }] }) });
  await relabel.done;
  assert.notEqual(first.id, relabel.id, 'a new detector version makes a new id');
  writer.close('ok', {});
  const second = rowsOf(dir).filter(r => r.event === 'annotation').at(-1);
  assert.equal(second.data.supersedes, first.id);
});

test('grader outcomes settle as convention-shape verdict points', async t => {
  const dir = scratch(t);
  const writer = openWriter(dir);
  const target = { trace: writer.trace, run: writer.run, span: 's'.repeat(16) };
  const call = annotate(writer, { detector, target, input_sha256: 'b'.repeat(64), chunk: { span: target.span },
    run: () => ({ correct: true, score: 1, reward: 1, reason: 'matches' }) });
  assert.deepEqual(await call.done, { status: 'ok', span: call.span, id: call.id });
  writer.close('ok', {});
  const rows = rowsOf(dir);
  const verdicts = rows.filter(r => r.event === 'verdict');
  assert.equal(verdicts.length, 1);
  assert.deepEqual(Object.keys(verdicts[0].data).sort(),
    ['correct', 'grader', 'name', 'reason', 'reward', 'run', 'score', 'span', 'trace']);
  assert.deepEqual(verdicts[0].data.grader, detector);
  assert.equal(verdicts[0].data.name, 'shape');
  assert.equal(verdicts[0].data.run, writer.run);
  assert.equal(verdicts[0].data.trace, writer.trace);
  assert.equal(verdicts[0].data.span, target.span);
  assert.equal(rows.find(r => r.event === 'annotate' && r.state === 'end').outcome, 'ok');
});

test('misuse throws synchronously: bad detector, bad target, bad run, bad writer', t => {
  const dir = scratch(t);
  const writer = openWriter(dir);
  const target = { trace: writer.trace, run: writer.run };
  const run = () => ({ labels: [] });
  assert.throws(() => annotate(writer, { detector: { name: '', version: '1', kind: 'code' }, target, run }));
  assert.throws(() => annotate(writer, { detector: { name: 'x', version: '1', kind: 'guess' }, target, run }));
  assert.throws(() => annotate(writer, { detector, target: { trace: 't' }, run }));
  assert.throws(() => annotate(writer, { detector, target }));
  assert.throws(() => annotate(writer, { detector, target, run: null }));
  assert.throws(() => annotate(null, { detector, target, run }));
  writer.close('ok', {});
});

test('conventions vocabulary registers from the installed dependency', async t => {
  const { createHash: sha } = await import('node:crypto');
  const { readFileSync: read } = await import('node:fs');
  const { dirname, join: joinPath } = await import('node:path');
  const harness = await import('./harness.mjs');
  const trace = await import('../lib/writer-state.mjs');
  const registry = await import('../lib/registry.mjs');
  const dir = harness.testDir(t, 'annotate-conv-');
  harness.savedEnv(t);
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_TRACEPARENT;
  delete process.env.FLATTRACE_LEVEL;
  trace.resetTrace();
  registry.resetRegistryCache();
  t.after(() => trace.resetTrace());
  const file = registry.flattraceConventionsPath();
  const entry = registry.registerConventionsVocabulary();
  const bytes = read(file);
  assert.ok(file.endsWith('flattrace/schema/conventions-events.json'));
  assert.equal(entry.tool, 'flattrace-conventions');
  assert.equal(entry.sha256, sha('sha256').update(bytes).digest('hex'));
  // Version comes from the installed flattrace package manifest.
  let manifestDir = dirname(file);
  let flattraceVersion = null;
  for (;;) {
    manifestDir = dirname(manifestDir);
    let manifest = null;
    try { manifest = JSON.parse(read(joinPath(manifestDir, 'package.json'), 'utf8')); } catch { /* keep walking */ }
    if (manifest?.name === 'flattrace') { flattraceVersion = manifest.version; break; }
    if (manifestDir === dirname(manifestDir)) break;
  }
  assert.equal(entry.version, flattraceVersion);
  const listed = trace.vocabList();
  assert.ok(listed.some(v => v.tool === 'flattrace-conventions' && v.sha256 === entry.sha256));
  assert.equal(registry.registerConventionsVocabulary().sha256, entry.sha256, 'idempotent');
});
