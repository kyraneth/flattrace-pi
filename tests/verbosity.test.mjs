// Opt-in verbosity: silent by default, sanitized argv at level 2+, kinds
// only from the named allowlist, free text withheld by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as trace from '../lib/writer-state.mjs';
import { registerWorkTrace } from '../lib/work-trace.mjs';
import { registerOwnVocabulary } from '../lib/registry.mjs';
import { enableVerbosity, resetVerbosity, verbosityEnabled, TOOL_KINDS } from '../lib/verbosity.mjs';
import { harness, testDir, savedEnv } from './harness.mjs';

const readRows = dir => readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.jsonl'))), 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);

const setup = async (t, prefix, level, verbose = false) => {
  const dir = testDir(t, prefix);
  const saved = savedEnv(t);
  t.after(() => { resetVerbosity(); trace.resetTrace(); process.env = saved; });
  trace.resetTrace();
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_TRACEPARENT;
  if (level == null) delete process.env.FLATTRACE_LEVEL;
  else process.env.FLATTRACE_LEVEL = level;
  registerOwnVocabulary();
  // Verbosity registers at load, before the writer opens on session start.
  if (verbose) enableVerbosity();
  const h = harness();
  const work = registerWorkTrace(h.api, trace);
  work.attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  return { dir, h };
};

test('default level emits no action and declares no level-2 vocabulary', async t => {
  const { dir, h } = await setup(t, 'vb-off-', undefined);
  assert.equal(verbosityEnabled(), false);
  await h.emit('tool_call', { toolCallId: '1', toolName: 'read', input: { path: '/x/SKILL.md', command: 'SECRET_SEEDED_NEGATIVE' } });
  await h.emit('session_shutdown', { reason: 'quit' });
  const rows = readRows(dir);
  assert.ok(!rows.some(r => r.event === 'action'));
  const start = rows.find(r => r.event === 'run' && r.state === 'start');
  assert.ok(!start.data.vocabularies.some(v => v.tool === 'flattrace-pi-verbosity'));
  assert.doesNotMatch(JSON.stringify(rows), /SEEDED_NEGATIVE/);
});

test('level 2 emits sanitized action with allowlist kinds; free text withheld', async t => {
  const { dir, h } = await setup(t, 'vb-on-', '2', true);
  assert.equal(verbosityEnabled(), true);
  await h.emit('tool_call', { toolCallId: '1', toolName: 'read', input: { path: '/notes/SKILL.md' } });
  await h.emit('tool_call', { toolCallId: '2', toolName: 'bash',
    input: { command: 'echo PLANTED_SECRET_SEEDED_NEGATIVE', workdir: '/tmp' } });
  await h.emit('tool_call', { toolCallId: '3', toolName: 'custom-tool',
    input: { path: '/x', apiKey: 'KEY_SEEDED_NEGATIVE' } });
  await h.emit('session_shutdown', { reason: 'quit' });
  const rows = readRows(dir), body = JSON.stringify(rows);
  assert.doesNotMatch(body, /SEEDED_NEGATIVE/);
  const actions = rows.filter(r => r.event === 'action');
  assert.equal(actions.length, 3);
  const read = actions.find(r => r.data.toolName === 'read');
  assert.equal(read.data.kind, 'read');
  assert.ok(read.data.argv.includes('path=/notes/SKILL.md'));
  const start = rows.find(r => r.event === 'run' && r.state === 'start');
  assert.ok(start.data.vocabularies.some(v => v.tool === 'flattrace-pi-verbosity'),
    'level-2 fragment listed in the run start');
  const bash = actions.find(r => r.data.toolName === 'bash');
  assert.equal(bash.data.kind, 'exec');
  assert.ok(!bash.data.argv.some(a => a.includes('echo')), 'free-text command never stored');
  assert.ok(bash.data.withheldParams.includes('command'));
  const custom = actions.find(r => r.data.toolName === 'custom-tool');
  assert.equal(custom.data.kind, null, 'unknown tools get no invented kind');
  for (const name of ['read', 'edit', 'write', 'bash', 'powershell', 'grep', 'find', 'ls']) {
    assert.ok(TOOL_KINDS.has(name), `allowlist names ${name}`);
  }
});

test('enableVerbosity at level 1 is a no-op returning false', t => {
  savedEnv(t);
  trace.resetTrace();
  process.env.FLATTRACE_LEVEL = '1';
  resetVerbosity();
  assert.equal(enableVerbosity(), false);
  assert.equal(verbosityEnabled(), false);
  assert.ok(!trace.vocabList().some(v => v.tool === 'flattrace-pi-verbosity'));
  trace.resetTrace();
  delete process.env.FLATTRACE_LEVEL;
});
