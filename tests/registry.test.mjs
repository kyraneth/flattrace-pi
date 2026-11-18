// Extension-point contracts: load-time registration, late errors, reserved
// redefinition refused, byte hashing, detector/grader validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as trace from '../lib/writer-state.mjs';
import { registerVocabulary, registerDetector, registerGrader, emitPoint, registerOwnVocabulary } from '../lib/registry.mjs';
import { testDir, savedEnv, enableTrace } from './harness.mjs';

const setup = (t, prefix) => {
  const dir = testDir(t, prefix);
  enableTrace(t, trace, dir);
  registerOwnVocabulary();
  return dir;
};

const fragment = (dir, name, events, pkg = { name: 'fixture-fragment', version: '0.0.1' }) => {
  const pkgDir = join(dir, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
  const path = join(pkgDir, 'events.json');
  writeFileSync(path, JSON.stringify({ tool: pkg.name, events }, null, 2));
  return path;
};

test('vocabulary registers package name/version with the exact-bytes hash', t => {
  setup(t, 'reg-basic-');
  const dir = testDir(t, 'reg-frag-');
  const path = fragment(dir, 'frag', { 'frag.note': { kind: 'point', fields: { text: 'a note' } } });
  const entry = registerVocabulary(path);
  assert.equal(entry.tool, 'fixture-fragment');
  assert.equal(entry.version, '0.0.1');
  assert.equal(entry.sha256, createHash('sha256').update(readFileSync(path)).digest('hex'));
  assert.deepEqual(trace.vocabList().find(v => v.tool === 'fixture-fragment'), entry);
});

test('registration after the writer opened throws and never rewrites the start', async t => {
  const dir = setup(t, 'reg-late-');
  // Open the writer first (as session start would).
  const { registerWorkTrace } = await import('../lib/work-trace.mjs');
  const { harness } = await import('./harness.mjs');
  const h = harness();
  const work = registerWorkTrace(h.api, trace);
  work.attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  assert.ok(trace.currentWriter());
  const fragDir = testDir(t, 'reg-latefrag-');
  const path = fragment(fragDir, 'late', { 'late.note': { kind: 'point', fields: {} } });
  assert.throws(() => registerVocabulary(path), /after the writer opened/);
  assert.throws(() => registerDetector({ name: 'd', version: '1', kind: 'code', run: () => ({}) }), /after the writer opened/);
  assert.throws(() => registerGrader({ name: 'g', version: '1', kind: 'code', run: () => ({}) }), /after the writer opened/);
  const runStart = JSON.parse(readFileSync(join(dir,
    readdirSync(dir).find(f => f.endsWith('.jsonl'))), 'utf8').split('\n')[0]);
  assert.ok(!runStart.data.vocabularies.some(v => v.tool === 'fixture-fragment' && v.sha256 && path.includes('late')),
    'flushed start line unchanged by late attempts');
  await h.emit('session_shutdown', { reason: 'quit' });
});

test('a fragment redefining pi.* or run differently is refused', t => {
  setup(t, 'reg-redefine-');
  const dir = testDir(t, 'reg-redfrag-');
  const changed = fragment(dir, 'changed', { 'pi.tool': { kind: 'span', fields: { invented: 'yes' } } });
  assert.throws(() => registerVocabulary(changed), /redefines 'pi\.tool' differently/);
  const changedRun = fragment(dir, 'changedrun', { run: { kind: 'span', fields: { invented: 'yes' } } });
  assert.throws(() => registerVocabulary(changedRun), /redefines 'run' differently/);
  const unknownReserved = fragment(dir, 'unknown', { 'pi.unknown-thing': { kind: 'point', fields: {} } });
  assert.throws(() => registerVocabulary(unknownReserved), /unknown to this recorder/);
  assert.ok(!trace.vocabList().some(v => v.sha256 && [changed, changedRun, unknownReserved].includes(v.path)));
});

test('same-contract detector re-registration is idempotent after open; changes and new names still throw', async t => {
  setup(t, 'reg-rerun-');
  const first = () => ({ labels: [] });
  registerDetector({ name: 'shape', version: '1.0.0', kind: 'code', run: first });
  const { registerWorkTrace } = await import('../lib/work-trace.mjs');
  const { harness } = await import('./harness.mjs');
  const h = harness();
  registerWorkTrace(h.api, trace).attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  assert.ok(trace.currentWriter(), 'writer open');
  // Extension factories re-run on session rotation: the same contract
  // replaces the call instead of throwing.
  const second = () => ({ labels: [] });
  assert.equal(registerDetector({ name: 'shape', version: '1.0.0', kind: 'code', run: second }), 'shape');
  assert.equal(trace.detectors.find(d => d.name === 'shape').run, second);
  assert.throws(() => registerDetector({ name: 'shape', version: '2.0.0', kind: 'code', run: second }),
    /redefines version\/kind after the writer opened/);
  assert.throws(() => registerDetector({ name: 'shape', version: '1.0.0', kind: 'model', run: second }),
    /redefines version\/kind after the writer opened/);
  assert.throws(() => registerDetector({ name: 'new-late', version: '1.0.0', kind: 'code', run: second }),
    /after the writer opened/);
  assert.throws(() => registerGrader({ name: 'grade-late', version: '1.0.0', kind: 'code', run: async () => ({}) }),
    /after the writer opened/);
  await h.emit('session_shutdown', { reason: 'quit' });
});

test('detector/grader entries validate shape; same name replaces on reload', t => {
  setup(t, 'reg-plugin-');
  assert.throws(() => registerDetector(null), /needs an entry object/);
  assert.throws(() => registerDetector({ name: 'd', version: '1', kind: 'oracle', run: () => ({}) }), /kind must be/);
  assert.throws(() => registerDetector({ name: 'd', version: '1', kind: 'code' }), /needs a run function/);
  const first = () => ({ labels: [] });
  const second = () => ({ labels: [] });
  registerDetector({ name: 'dup', version: '1.0.0', kind: 'code', run: first });
  registerDetector({ name: 'dup', version: '1.0.0', kind: 'code', run: second });
  assert.equal(trace.detectors.filter(d => d.name === 'dup').length, 1);
  assert.equal(trace.detectors.find(d => d.name === 'dup').run, second);
  registerGrader({ name: 'g', version: '2.0.0', kind: 'model', questions: ['q?'], run: async () => ({ correct: true }) });
  assert.equal(trace.graders.find(g => g.name === 'g').questions[0], 'q?');
});

test('emitPoint refuses undeclared names and the off state', async t => {
  const dir = setup(t, 'reg-emit-');
  assert.equal(emitPoint('no.such.event'), null, 'before an active run, undeclared names are no-ops');
  const fragDir = testDir(t, 'reg-emitfrag-');
  const path = fragment(fragDir, 'emitfrag', { 'emitfrag.note': { kind: 'point', fields: { v: 'x' } } });
  registerVocabulary(path);
  const { registerWorkTrace } = await import('../lib/work-trace.mjs');
  const { harness } = await import('./harness.mjs');
  const h = harness();
  const work = registerWorkTrace(h.api, trace);
  work.attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(emitPoint('emitfrag.note', { v: '1' }), true);
  const body = readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.jsonl'))), 'utf8');
  assert.ok(body.includes('emitfrag.note'));
  await h.emit('session_shutdown', { reason: 'quit' });
});
