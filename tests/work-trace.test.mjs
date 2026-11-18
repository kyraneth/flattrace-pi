// Recorder behavior: metadata, exact joins, privacy, late spans, rotation,
// user-entry identity join, skill reads, verbosity hooks, detectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as trace from '../lib/writer-state.mjs';
import { registerWorkTrace } from '../lib/work-trace.mjs';
import { registerOwnVocabulary, registerDetector, registerGrader } from '../lib/registry.mjs';
import { harness, testDir, enableTrace, assistantMessage, runActivity } from './harness.mjs';

const open = async (t, prefix, attach = true) => {
  const dir = testDir(t, prefix);
  enableTrace(t, trace, dir);
  registerOwnVocabulary();
  const h = harness();
  const work = registerWorkTrace(h.api, trace);
  if (attach) work.attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  return { dir, h, work };
};
const readRows = dir => readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.jsonl'))), 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);

test('native metadata: parallel/nested tool context, exact joins, first token, privacy', async t => {
  const { dir, h } = await open(t, 'wt-meta-');
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('before_provider_request', { payload: { apiKey: 'REQUEST_SEEDED_NEGATIVE' } });
  await h.emit('before_provider_headers', { headers: { authorization: 'HEADER_SEEDED_NEGATIVE' } });
  await h.emit('after_provider_response', { status: 429, headers: { authorization: 'HEADER_SEEDED_NEGATIVE', 'retry-after': '0' } });
  await h.emit('before_provider_request', { payload: {} });
  await h.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'THINKING_SEEDED_NEGATIVE' } });
  await h.emit('message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'STREAM_SEEDED_NEGATIVE' } });
  await h.emit('message_end', { message: assistantMessage() });
  for (const [toolCallId, parentToolCallId] of [['a', null], ['b', null], ['a/1', 'a']]) {
    await h.emit('tool_execution_start', { toolCallId, parentToolCallId, toolName: 'bash' });
  }
  for (const toolCallId of ['a/1', 'b', 'a']) {
    await h.emit('tool_execution_end', { toolCallId, toolName: 'bash', isError: toolCallId === 'b', durationMs: 1,
      result: { content: ['OUTPUT_SEEDED_NEGATIVE'],
        details: { truncation: { truncated: true, totalBytes: 3, totalLines: 1, outputBytes: 1, outputLines: 1 }, fullOutputPath: 'PATH_SEEDED_NEGATIVE' },
        structuredContent: { output: 'STRUCTURED_SEEDED_NEGATIVE', truncated: false } } });
  }
  h.entries.set('ra', { message: { toolCallId: 'a' } });
  h.entries.set('rb', { message: { toolCallId: 'b' } });
  await h.emit('turn_end', { message: assistantMessage(), messageEntryId: 'assistant', toolResultEntryIds: ['ra', 'rb'], outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_end', { messages: [assistantMessage()] });
  await h.emit('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_settled', { aborted: false });
  await h.emit('session_shutdown', { reason: 'quit' });
  assert.equal(trace.currentWriter(), null);
  const rows = readRows(dir), body = JSON.stringify(rows);
  assert.doesNotMatch(body, /SEEDED_NEGATIVE/);
  const starts = rows.filter(r => r.state === 'start'), ends = rows.filter(r => r.state === 'end');
  assert.equal(starts.length, ends.length, 'every opened span paired');
  const turn = starts.find(r => r.event === 'pi.turn'), tools = starts.filter(r => r.event === 'pi.tool');
  assert.equal(tools[0].parent, turn.span);
  assert.equal(tools[1].parent, turn.span);
  assert.equal(tools[2].parent, tools[0].span, 'nested call attributed to enclosing tool span');
  assert.equal(ends.find(r => r.span === tools[1].span).outcome, 'error');
  const links = rows.filter(r => r.event === 'pi.journal');
  assert.deepEqual(links.filter(r => r.data.toolCallId).map(r => [r.data.toolCallId, r.data.entryId]), [['a', 'ra'], ['b', 'rb'], ['a/1', 'ra']]);
  const models = ends.filter(r => r.event === 'pi.model');
  assert.equal(models[0].outcome, 'error');
  assert.equal(models[0].data.httpStatus, 429);
  assert.equal(models[0].data.providerAttemptCount, null);
  assert.equal(models[0].data.exposedHttpAttemptCount, 1);
  assert.equal(models[1].data.firstDeltaKind, 'thinking_delta');
  assert.ok(models[1].data.firstDeltaMs >= 0);
  assert.equal(models[1].data.totalTokens, 6);
  assert.equal(rows.filter(r => r.event === 'pi.model.first_token').length, 1, 'one point, not one per delta');
  const agent = ends.find(r => r.event === 'pi.agent'), run = ends.find(r => r.event === 'run');
  assert.equal(agent.data.summary.toolCount, 3);
  assert.equal(agent.data.summary.toolsByName.bash.calls, 3);
  assert.equal(agent.data.summary.nestedToolCount, 1);
  assert.equal(agent.data.summary.usage.totalTokens, 6);
  assert.equal(run.data.cancelledAtQuit, 0);
  assert.ok(ends.filter(r => r.event === 'pi.tool').every(r => r.data.truncated === true && r.data.structuredTruncated === false && r.data.fullOutputPathPresent === true));
});

test('user entry joined by object identity, never by text; steered input left unjoined', async t => {
  const { dir, h } = await open(t, 'wt-user-');
  const userA = { role: 'user', content: [{ type: 'text', text: 'SAME_TEXT_SEEDED' }] };
  const userB = { role: 'user', content: [{ type: 'text', text: 'SAME_TEXT_SEEDED' }] };
  await h.emit('message_start', { message: userA });
  await h.emit('message_end', { message: userA });
  // Pi persists the same object after extensions return from message_end.
  h.branch.push({ id: 'u1', type: 'message', message: userA });
  // A steered input with identical text is a different object and never lands.
  await h.emit('message_start', { message: userB });
  await h.emit('message_end', { message: userB });
  await h.emit('before_agent_start', { messageType: 'user' });
  const rows = readRows(dir);
  const joins = rows.filter(r => r.event === 'pi.journal' && r.data.role === 'user');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].data.entryId, 'u1');
  assert.ok(joins[0].data.spanId, 'joined to the admitted activity span');
  await h.emit('session_shutdown', { reason: 'quit' });
  const after = readRows(dir);
  assert.equal(after.filter(r => r.event === 'pi.journal' && r.data.role === 'user').length, 1, 'steered input left unjoined');
  assert.doesNotMatch(JSON.stringify(after), /SEEDED/);
});

test('command skill block hashes the persisted body, never the disk', async t => {
  const { createHash: sha } = await import('node:crypto');
  const { dir, h } = await open(t, 'wt-skillcmd-');
  const skillDir = join(dir, 'skills', 'review');
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  writeFileSync(skillFile, '# review\nRead carefully.\n');
  const user = { role: 'user', content: [{ type: 'text',
    text: `<skill name="review" location="${skillFile}">\nbody\n</skill>\n\nplease review` }] };
  await h.emit('message_end', { message: user });
  h.branch.push({ id: 'u2', type: 'message', message: user });
  // The file changes on disk after the expansion was persisted. The hash
  // must still equal the block body, not the new disk bytes.
  writeFileSync(skillFile, '# review\nCHANGED_ON_DISK\n');
  await h.emit('before_agent_start', { messageType: 'user' });
  const rows = readRows(dir);
  const reads = rows.filter(r => r.event === 'pi.skill.read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].data.name, 'review');
  assert.equal(reads[0].data.path, skillFile);
  assert.equal(reads[0].data.source, 'command');
  assert.equal(reads[0].data.range, null);
  assert.equal(reads[0].data.complete, true);
  assert.equal(reads[0].data.bytes, Buffer.byteLength('body', 'utf8'));
  assert.equal(reads[0].data.content_sha256, sha('sha256').update('body', 'utf8').digest('hex'));
  assert.ok(!('content' in reads[0].data));
  assert.doesNotMatch(JSON.stringify(rows), /CHANGED_ON_DISK/);
  assert.doesNotMatch(JSON.stringify(rows), /Read carefully/);
  await h.emit('session_shutdown', { reason: 'quit' });
});

test('tool skill reads emit on tool_result with the returned text; failures emit nothing', async t => {
  const { createHash: sha } = await import('node:crypto');
  const digest = text => sha('sha256').update(text, 'utf8').digest('hex');
  const { dir, h } = await open(t, 'wt-skilltool-');
  const skillDir = join(dir, 'skills', 'plan');
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  writeFileSync(skillFile, '# plan\n');
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  const resultFor = text => ({ content: [{ type: 'text', text }], structuredContent: text, details: {} });
  // tool_call alone emits nothing: acquisition is measured on the result.
  await h.emit('tool_execution_start', { toolCallId: 'whole', toolName: 'read' });
  await h.emit('tool_call', { toolCallId: 'whole', toolName: 'read', input: { path: skillFile } });
  assert.equal(readRows(dir).filter(r => r.event === 'pi.skill.read').length, 0);
  await h.emit('tool_result', { toolCallId: 'whole', toolName: 'read',
    input: { path: skillFile }, ...resultFor('# plan\n'), isError: false });
  // Partial offset/limit read: range set, complete false.
  await h.emit('tool_execution_start', { toolCallId: 'part', toolName: 'read' });
  await h.emit('tool_call', { toolCallId: 'part', toolName: 'read',
    input: { path: skillFile, offset: 2, limit: 3 } });
  await h.emit('tool_result', { toolCallId: 'part', toolName: 'read',
    input: { path: skillFile, offset: 2, limit: 3 }, ...resultFor('partial\n'), isError: false });
  // Truncated whole read: complete false even with no range.
  await h.emit('tool_execution_start', { toolCallId: 'trunc', toolName: 'read' });
  await h.emit('tool_result', { toolCallId: 'trunc', toolName: 'read', input: { path: skillFile },
    content: [{ type: 'text', text: 'head\n' }], structuredContent: 'head\n',
    details: { truncation: { truncated: true, outputBytes: 5 } }, isError: false });
  // Failed read: no point, no acquired or complete claim.
  await h.emit('tool_execution_start', { toolCallId: 'missing', toolName: 'read' });
  await h.emit('tool_result', { toolCallId: 'missing', toolName: 'read',
    input: { path: join(skillDir, 'absent.md') },
    content: [{ type: 'text', text: 'Error: ENOENT' }], isError: true });
  // A non-skill path is ignored even on success.
  await h.emit('tool_execution_start', { toolCallId: 'plain', toolName: 'read' });
  await h.emit('tool_result', { toolCallId: 'plain', toolName: 'read',
    input: { path: join(dir, 'other.txt') }, ...resultFor('other\n'), isError: false });
  const reads = readRows(dir).filter(r => r.event === 'pi.skill.read');
  assert.equal(reads.length, 3, 'no point for the failed or the non-skill read');
  const byCall = new Map();
  for (const row of readRows(dir).filter(r => r.event === 'pi.tool' && r.state === 'start')) byCall.set(row.data.toolCallId, row.span);
  const whole = reads.find(r => r.data.content_sha256 === digest('# plan\n'));
  assert.ok(whole, 'whole returned text hashed');
  assert.equal(whole.data.source, 'tool');
  assert.equal(whole.data.complete, true);
  assert.equal(whole.data.range, null);
  assert.equal(whole.span, byCall.get('whole'), 'top-level read joins its own execution span');
  const part = reads.find(r => r.data.content_sha256 === digest('partial\n'));
  assert.ok(part, 'partial returned text hashed');
  assert.deepEqual(part.data.range, { offset: 2, limit: 3 });
  assert.equal(part.data.complete, false);
  const trunc = reads.find(r => r.data.content_sha256 === digest('head\n'));
  assert.ok(trunc, 'truncated returned text hashed');
  assert.equal(trunc.data.complete, false);
  assert.equal(trunc.data.range, null);
  assert.ok(reads.every(r => !('content' in r.data)));
  assert.ok(!reads.some(r => JSON.stringify(r.data).includes('absent')));
  await h.emit('tool_execution_end', { toolCallId: 'whole', toolName: 'read', isError: false, durationMs: 1, result: {} });
  await h.emit('tool_execution_end', { toolCallId: 'part', toolName: 'read', isError: false, durationMs: 1, result: {} });
  await h.emit('tool_execution_end', { toolCallId: 'trunc', toolName: 'read', isError: false, durationMs: 1, result: {} });
  await h.emit('tool_execution_end', { toolCallId: 'missing', toolName: 'read', isError: true, durationMs: 1, result: {} });
  await h.emit('tool_execution_end', { toolCallId: 'plain', toolName: 'read', isError: false, durationMs: 1, result: {} });
  h.entries.set('m', { message: { role: 'assistant' } });
  await h.emit('turn_end', { message: assistantMessage(), messageEntryId: 'm', toolResultEntryIds: [], outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_end', { messages: [assistantMessage()] });
  await h.emit('agent_settled', { aborted: false });
  await h.emit('session_shutdown', { reason: 'quit' });
});

test('nested codemode skill reads carry the real enclosing call id', async t => {
  const { createHash: sha } = await import('node:crypto');
  const { dir, h } = await open(t, 'wt-skillnested-');
  const skillDir = join(dir, 'skills', 'plan');
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  writeFileSync(skillFile, '# plan\n');
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('tool_execution_start', { toolCallId: '7', toolName: 'codemode' });
  await h.emit('tool_execution_start', { toolCallId: '7/1', parentToolCallId: '7', toolName: 'read' });
  await h.emit('tool_call', { toolCallId: '7/1', parentToolCallId: '7', toolName: 'read', input: { path: skillFile } });
  await h.emit('tool_result', { toolCallId: '7/1', parentToolCallId: '7', toolName: 'read',
    input: { path: skillFile }, content: [{ type: 'text', text: '# plan\n' }],
    structuredContent: '# plan\n', details: {}, isError: false });
  const rows = readRows(dir);
  const reads = rows.filter(r => r.event === 'pi.skill.read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].data.source, 'tool');
  assert.equal(reads[0].data.parentToolCallId, '7');
  assert.equal(reads[0].data.content_sha256, sha('sha256').update('# plan\n', 'utf8').digest('hex'));
  const innerSpan = rows.find(r => r.event === 'pi.tool' && r.state === 'start' && r.data.toolCallId === '7/1').span;
  assert.equal(reads[0].span, innerSpan, 'nested read joins its own execution span first');
  await h.emit('tool_execution_end', { toolCallId: '7/1', toolName: 'read', isError: false, durationMs: 1, result: {} });
  await h.emit('tool_execution_end', { toolCallId: '7', toolName: 'codemode', isError: false, durationMs: 1, result: {} });
  h.entries.set('m', { message: { role: 'assistant' } });
  await h.emit('turn_end', { message: assistantMessage(), messageEntryId: 'm', toolResultEntryIds: [], outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_end', { messages: [assistantMessage()] });
  await h.emit('agent_settled', { aborted: false });
  await h.emit('session_shutdown', { reason: 'quit' });
});

test('interrupted quit ends open spans cancelled with no invented snapshot event', async t => {
  const { dir, h } = await open(t, 'wt-quit-');
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('before_provider_request', { payload: {} });
  await h.emit('tool_execution_start', { toolCallId: 'pending', toolName: 'pending' });
  await h.emit('session_shutdown', { reason: 'quit' });
  const rows = readRows(dir);
  const openSpans = rows.filter(r => r.state === 'start');
  const ends = new Map(rows.filter(r => r.state === 'end').map(r => [r.span, r]));
  const workSpans = openSpans.filter(s => s.event !== 'run');
  assert.ok(workSpans.length >= 3, 'agent, turn and tool spans opened');
  for (const s of workSpans) assert.equal(ends.get(s.span)?.outcome, 'cancelled', s.event);
  assert.ok(!rows.some(r => r.event === 'session.shutdown'), 'no foreign lifecycle snapshot point');
  const runEnd = rows.find(r => r.event === 'run' && r.state === 'end');
  assert.equal(runEnd.data.cancelledAtQuit, workSpans.length);
  assert.equal(runEnd.outcome, 'ok');
});

test('session replacement rotates to a linked run file and keeps one active run', async t => {
  const { dir, h } = await open(t, 'wt-rotate-');
  await runActivity(h, { sessionId: 'session' });
  // Native replacement emits shutdown while the old session is still bound;
  // the new id is observable only at the next session_start.
  await h.emit('session_shutdown', { reason: 'new' });
  h.ctx.sessionId = 'session-2';
  await h.emit('session_start', { reason: 'new' });
  await runActivity(h, { sessionId: 'session-2' });
  await h.emit('session_shutdown', { reason: 'quit' });
  const { readdirSync: list } = await import('node:fs');
  const all = list(dir).filter(f => f.endsWith('.jsonl'));
  assert.equal(all.length, 2, 'one file per session');
  const per = new Map();
  for (const f of all) {
    for (const row of readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) {
      (per.get(row.run) ?? per.set(row.run, []).get(row.run)).push(row);
    }
  }
  assert.equal(per.size, 2);
  const runs = [...per.values()].map(rows => ({ start: rows.find(r => r.event === 'run' && r.state === 'start'), end: rows.find(r => r.event === 'run' && r.state === 'end') }));
  const linked = runs.find(r => r.start.data.links);
  assert.ok(linked, 'second run carries the continuation link');
  assert.deepEqual(linked.start.data.links, [{ relation: 'continues_process', trace: runs[0].start.trace, run: runs[0].start.run }]);
  const binds = [...per.values()].flatMap(rows => rows.filter(r => r.event === 'pi.session.bind'));
  assert.equal(binds.length, 2, 'first bind plus rotation bind');
  assert.ok(runs.every(r => r.end && r.start.data.sessionId), 'both runs paired with session ids');
});

test('detectors wrap calls in annotate spans; refusal and error recorded; close never waits', async t => {
  // Detectors register at load, before the writer opens: register first.
  const preDir = testDir(t, 'wt-detectors-');
  const { createHash: sha } = await import('node:crypto');
  enableTrace(t, trace, preDir);
  registerOwnVocabulary();
  let releaseModel = null;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  registerDetector({ name: 'code-shape', version: '1.0.0', kind: 'code',
    run: () => ({ labels: [{ label: 'shape-seen', probability: 1 }] }) });
  registerDetector({ name: 'picky', version: '1.0.0', kind: 'code', run: () => ({ refused: true, reason: 'not my shape' }) });
  registerDetector({ name: 'slow-model', version: '0.2.0', kind: 'model', run: () => modelGate.then(() => ({ labels: [{ label: 'late', probability: null }] })) });
  registerGrader({ name: 'grade-it', version: '3.0.0', kind: 'code', run: () => ({ correct: true, score: 1, reward: 1, reason: 'matches' }) });
  const h = harness();
  const work = registerWorkTrace(h.api, trace);
  work.attach(h.api);
  await h.emit('session_start', { reason: 'startup' });
  const dir = preDir;
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('message_end', { message: assistantMessage() });
  h.entries.set('m1', { id: 'm1', message: { role: 'assistant', content: 'ENTRY_SEEDED_NEGATIVE' } });
  await h.emit('turn_end', { message: assistantMessage(), messageEntryId: 'm1', toolResultEntryIds: [], outcome: 'completed', continue: false, entries: [] });
  await new Promise(resolve => setTimeout(resolve, 100));
  let rows = readRows(dir);
  const annotates = rows.filter(r => r.event === 'annotate' && r.state === 'end');
  const ended = outcome => annotates.filter(r => r.outcome === outcome).map(r => r.data.detector.name);
  assert.ok(ended('ok').includes('code-shape'));
  assert.ok(ended('refused').includes('picky'));
  assert.ok(ended('ok').includes('grade-it'));
  // The convention shape: span data carries the detector identity object
  // and the input hash, never flat target ids.
  const shapeSpan = rows.find(r => r.event === 'annotate' && r.state === 'start' && r.data.detector?.name === 'code-shape');
  assert.deepEqual(shapeSpan.data.detector, { name: 'code-shape', version: '1.0.0', kind: 'code' });
  assert.equal(typeof shapeSpan.data.input_sha256, 'string');
  assert.ok(!('targetEntryId' in shapeSpan.data) && !('targetSpanId' in shapeSpan.data));
  const shapeEnd = annotates.find(r => r.span === shapeSpan.span);
  assert.ok(shapeEnd.data.usage === null || typeof shapeEnd.data.usage === 'object');
  const entryHash = sha('sha256').update(JSON.stringify({ role: 'assistant', content: 'ENTRY_SEEDED_NEGATIVE' })).digest('hex');
  assert.equal(shapeSpan.data.input_sha256, entryHash);
  const points = rows.filter(r => r.event === 'annotation' && r.data.label === 'shape-seen');
  assert.equal(points.length, 1);
  const turnSpan = rows.find(r => r.event === 'pi.turn' && r.state === 'start').span;
  assert.deepEqual(points[0].data.target, { trace: rows[0].trace, run: rows[0].run, span: turnSpan, entryId: 'm1' });
  assert.deepEqual(points[0].data.detector, { name: 'code-shape', version: '1.0.0', kind: 'code' });
  assert.match(points[0].data.id, /^[0-9a-f]{64}$/);
  assert.equal(points[0].data.probability, 1);
  assert.equal(points[0].data.input_sha256, entryHash);
  assert.ok(!('targetEntryId' in points[0].data) && !('supersedes' in points[0].data));
  const refused = annotates.find(r => r.data.detector?.name === 'picky');
  assert.equal(refused.data.refusalReason, 'not my shape');
  const verdicts = rows.filter(r => r.event === 'verdict');
  assert.equal(verdicts.length, 1);
  assert.deepEqual(verdicts[0].data.grader, { name: 'grade-it', version: '3.0.0', kind: 'code' });
  assert.equal(verdicts[0].data.correct, true);
  assert.equal(verdicts[0].data.run, rows[0].run);
  assert.equal(verdicts[0].data.trace, rows[0].trace);
  assert.equal(verdicts[0].data.span, turnSpan);
  assert.ok(!('targetEntryId' in verdicts[0].data));
  assert.doesNotMatch(JSON.stringify(rows), /ENTRY_SEEDED_NEGATIVE/, 'entry bytes hashed, never stored');
  // Quit while the model call is still in flight: cancelled, close returns now.
  await h.emit('agent_end', { messages: [assistantMessage()] });
  await h.emit('session_shutdown', { reason: 'quit' });
  releaseModel();
  await new Promise(resolve => setTimeout(resolve, 100));
  rows = readRows(dir);
  const slow = rows.filter(r => r.event === 'annotate' && r.data.detector?.name === 'slow-model');
  assert.equal(slow.filter(r => r.state === 'end').length, 1);
  assert.equal(slow.find(r => r.state === 'end').outcome, 'cancelled');
});

test('unjoined idle provider hooks do not invent a span; usage stays unknown', async t => {
  const { dir, h } = await open(t, 'wt-unjoined-');
  await h.emit('before_provider_request', { payload: {} });
  await h.emit('after_provider_response', { status: 200, headers: {} });
  await h.emit('session_shutdown', { reason: 'quit' });
  const rows = readRows(dir);
  const run = rows.find(r => r.event === 'run' && r.state === 'end');
  assert.ok(run);
  assert.equal(run.data.summary.unjoinedProviderRequestCount, 1);
  assert.equal(run.data.summary.usage.totalTokens, null);
  assert.ok(rows.some(r => r.event === 'pi.model.unjoined' && r.data.completionObserved === false));
});

test('compaction failure without a start preserves metadata and spares requests', async t => {
  const { dir, h } = await open(t, 'wt-compact-');
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('before_provider_request', { payload: {} });
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, willRetry: false, fromExtension: false });
  await h.emit('message_end', { message: assistantMessage() });
  h.entries.set('m', { message: { role: 'assistant' } });
  await h.emit('turn_end', { message: assistantMessage(), messageEntryId: 'm', toolResultEntryIds: [], outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_end', { messages: [assistantMessage()] });
  await h.emit('agent_settled', { aborted: false });
  await h.emit('session_shutdown', { reason: 'quit' });
  const rows = readRows(dir);
  const point = rows.find(r => r.event === 'pi.compaction.unstarted');
  assert.equal(point.data.phase, 'failed');
  assert.equal(point.data.nativeDurationMs, null);
  assert.equal(rows.filter(r => r.event === 'pi.model' && r.state === 'start').length, 1);
});

test('off observers never allocate a writer or touch the sink', async t => {
  const saved = { ...process.env };
  const dir = testDir(t, 'wt-offstate-');
  try {
    trace.resetTrace();
    delete process.env.FLATTRACE_DIR;
    const h = harness();
    const work = registerWorkTrace(h.api, trace);
    work.attach(h.api);
    await h.emit('session_start', { reason: 'startup' });
    await h.emit('input', { source: 'interactive' });
    await h.emit('before_agent_start', { messageType: 'user' });
    await h.emit('turn_start', { turnIndex: 0 });
    assert.equal(trace.currentWriter(), null);
    const { readdirSync: list } = await import('node:fs');
    assert.deepEqual(list(dir), []);
  } finally {
    process.env = saved;
    trace.resetTrace();
  }
});

test('run-start vocabulary list matches the exact registered bytes', async t => {
  const { dir } = await open(t, 'wt-vocablist-');
  const { createHash: sha } = await import('node:crypto');
  const ownBytes = readFileSync(join(new URL('../', import.meta.url).pathname, 'flattrace-events.json'));
  const rows = readRows(dir);
  const start = rows.find(r => r.event === 'run' && r.state === 'start');
  assert.deepEqual(start.data.vocabularies, [{ tool: 'flattrace-pi', version: trace.RECORDER_VERSION,
    sha256: sha('sha256').update(ownBytes).digest('hex') }]);
});
