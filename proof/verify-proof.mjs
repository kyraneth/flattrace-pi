// Verify one live-proof run. Usage:
//   PROOF_CHECK_RUST=/path/to/flattrace-read-linux-x64 PROOF_CHECK_PY=/path/to/python \
//     PROOF_ROOT=/path/to/proof-root node verify-proof.mjs <a|b>
// Checker paths come from the environment (never baked in): every trace file
// is checked with both the 0.3.0 Rust CLI and the 0.3.0 Python checker using
// repeatable --events. Prints one line per claim (PASS/FAIL, checker output
// inline) and exits nonzero on any failure.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseSkillBlockText } from '../lib/skill-read.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = process.argv[2];
if (run !== 'a' && run !== 'b') {
  console.error('usage: node verify-proof.mjs <a|b>');
  process.exit(2);
}
const rootArg = process.argv[3] ?? process.env.PROOF_ROOT;
if (!rootArg) throw new Error('supply a proof root argument or PROOF_ROOT');
const root = resolve(rootArg);
const tracesDir = join(root, 'traces');
const sessionsDir = join(root, 'sessions');
const rustCli = process.env.PROOF_CHECK_RUST ?? null;
const pythonBin = process.env.PROOF_CHECK_PY ?? null;
const ownVocab = join(repo, 'flattrace-events.json');
const secondVocab = join(repo, 'proof', 'second-ext', 'events.json');
const lateVocab = join(repo, 'proof', 'late-events.json');
const childVocab = join(repo, 'proof', 'child-events.json');
const convVocab = join(repo, 'node_modules', 'flattrace', 'schema', 'conventions-events.json');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const expectedEnvelope = run === 'b' ? 'proof-host' : 'flattrace-pi';

let failures = 0;
const claim = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const rowsOf = f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const sha256File = f => createHash('sha256').update(readFileSync(f)).digest('hex');

// One trace file holds exactly one run; split session runs from the spawned
// child run by the envelope tool on the run-start line.
const traceFiles = readdirSync(tracesDir).filter(f => f.endsWith('.jsonl')).map(f => join(tracesDir, f));
const startOf = f => rowsOf(f).find(r => r.event === 'run' && r.state === 'start');
const sessionFiles = traceFiles.filter(f => startOf(f)?.tool === expectedEnvelope);
const childFiles = traceFiles.filter(f => startOf(f)?.tool === 'proof-child');

claim('session run count is two, child count is ' + (run === 'b' ? 'one' : 'zero'),
  sessionFiles.length === 2 && childFiles.length === (run === 'b' ? 1 : 0),
  `session=[${sessionFiles.map(f => f.split('/').pop()).join(', ')}] child=[${childFiles.map(f => f.split('/').pop()).join(', ')}]`);

const sessionRows = sessionFiles.flatMap(rowsOf);
const byRun = new Map();
for (const row of sessionRows) {
  (byRun.get(row.run) ?? byRun.set(row.run, []).get(row.run)).push(row);
}
claim('exactly two session runs', byRun.size === 2);
const runs = [...byRun.entries()].map(([id, rows]) => ({ id,
  start: rows.find(r => r.event === 'run' && r.state === 'start'),
  end: rows.find(r => r.event === 'run' && r.state === 'end'), rows,
  file: sessionFiles.find(f => rowsOf(f).some(r => r.run === id)) }));
const first = runs.find(r => !r.start.data.links);
const second = runs.find(r => r.start.data.links);
claim('second run links the first with continues_process',
  Boolean(second && first && second.start.data.links.length === 1 &&
    second.start.data.links[0].relation === 'continues_process' &&
    second.start.data.links[0].trace === first.start.trace &&
    second.start.data.links[0].run === first.id),
  second ? JSON.stringify(second.start.data.links) : 'no linked run');
claim('both runs paired with session ids and ok outcomes',
  runs.every(r => r.end && r.end.outcome === 'ok' && typeof r.start.data.sessionId === 'string'));
claim('session envelope carries the expected host tool',
  runs.every(r => r.start.tool === expectedEnvelope && r.start.tool_version ===
    (run === 'b' ? '0.1.0' : pkg.version)),
  runs.map(r => `${r.start.tool}@${r.start.tool_version}`).join(', '));

// The run-start manifest lists the vocabularies actually in force, with the
// exact file-byte hashes the union checker compares: the recorder
// vocabulary, the second-extension fragment on run b, and the dependency's
// conventions vocabulary (annotate/annotation/verdict/action/changes), all
// resolved to committed or installed files, never invented.
const ownHash = sha256File(ownVocab);
const convHash = sha256File(convVocab);
claim('both run starts list the recorder vocabulary with its exact byte hash',
  runs.every(r => (r.start.data.vocabularies ?? []).some(v =>
    v.tool === 'flattrace-pi' && v.version === pkg.version && v.sha256 === ownHash)));
claim('both run starts list the conventions vocabulary with its exact byte hash',
  runs.every(r => (r.start.data.vocabularies ?? []).some(v =>
    v.tool === 'flattrace-conventions' && v.sha256 === convHash)),
  convVocab.split('/').slice(-3).join('/'));
if (run === 'b') {
  const secondHash = sha256File(secondVocab);
  claim('both run starts list the second vocabulary with its exact byte hash',
    runs.every(r => (r.start.data.vocabularies ?? []).some(v =>
      v.tool === 'proof-second' && v.sha256 === secondHash)));
  claim('no late vocabulary leaked into the flushed run starts',
    runs.every(r => !(r.start.data.vocabularies ?? []).some(v => v.tool === 'proof-late')));
}

// Journal joins: every pi.journal user entry id must exist in a session file.
const sessionRecords = [];
const walk = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) sessionRecords.push(...rowsOf(p).map(r => ({ ...r, file: p })));
  }
};
walk(sessionsDir);
const entryById = new Map(sessionRecords.filter(r => r.id).map(r => [r.id, r]));
const joins = sessionRows.filter(x => x.event === 'pi.journal');
const userJoins = joins.filter(j => j.data.role === 'user');
claim('user-entry joins resolve to real journal entries by identity',
  userJoins.length >= 2 && userJoins.every(j => entryById.has(j.data.entryId)),
  userJoins.map(j => j.data.entryId).join(','));
const readJoins = joins.filter(j => j.data.toolCallId);
claim('tool spans joined to persisted tool-result entries',
  readJoins.length >= 2 && readJoins.every(j => entryById.has(j.data.entryId)));

// Skill reads: the command path hashes the persisted block body (never the
// disk); the tool path hashes the exact returned text with range/complete;
// a failed read emits no point at all.
const skillReads = sessionRows.filter(x => x.event === 'pi.skill.read');
const bySource = Object.groupBy ? Object.groupBy(skillReads, r => r.data.source) : {};
const skillOrigText = readFileSync(join(root, 'tmp', 'skill-orig.md'), 'utf8');
const skillOrigSha = createHash('sha256').update(skillOrigText, 'utf8').digest('hex');
const entryText = message => {
  if (!message || typeof message !== 'object') return null;
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text).join('\n') || null;
  }
  return null;
};
const commandRead = (bySource.command ?? []).find(r => r.data.name === 'demo');
claim('command skill read for the /skill: expansion, whole and complete',
  Boolean(commandRead && commandRead.data.complete === true && commandRead.data.range === null));
const skillBlockEntry = sessionRecords.find(r => r.type === 'message'
  && typeof entryText(r.message) === 'string' && entryText(r.message).includes('<skill name="demo"'));
const blockBody = skillBlockEntry ? parseSkillBlockText(entryText(skillBlockEntry.message))?.content : null;
claim('command hash equals the persisted block body',
  Boolean(commandRead && typeof blockBody === 'string'
    && commandRead.data.content_sha256 === createHash('sha256').update(blockBody, 'utf8').digest('hex')));
const skillDiskNow = commandRead ? readFileSync(commandRead.data.path, 'utf8') : null;
claim('the skill file really changed on disk after the expansion',
  skillDiskNow !== null && skillDiskNow !== skillOrigText);
claim('command hash is not the new disk bytes',
  Boolean(commandRead && skillDiskNow !== null
    && commandRead.data.content_sha256 !== createHash('sha256').update(skillDiskNow, 'utf8').digest('hex')));
const wholeRead = (bySource.tool ?? []).find(r => r.data.range === null
  && !r.data.parentToolCallId && r.data.complete === true);
claim('whole tool skill read hashes the returned text, not the disk',
  Boolean(wholeRead && wholeRead.data.content_sha256 === skillOrigSha
    && wholeRead.data.bytes === Buffer.byteLength(skillOrigText, 'utf8')));
// The partial read expectation re-derives Pi 1.4.0's read slicing
// (dist/core/tools/read.js): 1-indexed offset, line-limit slice, and the
// user-limit continuation notice appended to the returned text.
const partialRead = (bySource.tool ?? []).find(r => r.data.range?.offset === 2 && r.data.range?.limit === 2);
const origLines = skillOrigText.split('\n');
const partialSelected = origLines.slice(1, 3).join('\n');
const partialRemaining = origLines.length - 3;
const partialExpected = partialRemaining > 0
  ? `${partialSelected}\n\n[${partialRemaining} more lines in file. Use offset=4 to continue.]`
  : partialSelected;
claim('partial offset/limit read carries range, incomplete, exact text hash',
  Boolean(partialRead && partialRead.data.complete === false
    && partialRead.data.range.offset === 2 && partialRead.data.range.limit === 2
    && partialRead.data.content_sha256 === createHash('sha256').update(partialExpected, 'utf8').digest('hex')),
  partialRead ? `range=${JSON.stringify(partialRead.data.range)} complete=${partialRead.data.complete}` : 'no partial point');
claim('failed read emits no skill point at all',
  !skillReads.some(r => r.data.path.endsWith('absent.md')));
const toolStartByCall = new Map(sessionRows.filter(r => r.event === 'pi.tool' && r.state === 'start')
  .map(r => [r.data.toolCallId, r]));
const toolEndBySpan = new Map(sessionRows.filter(r => r.event === 'pi.tool' && r.state === 'end')
  .map(r => [r.span, r]));
const endOf = callId => { const s = toolStartByCall.get(callId); return s ? toolEndBySpan.get(s.span) : null; };
claim('the missing-file read actually failed',
  Boolean(endOf('proof-skill-missing') && endOf('proof-skill-missing').outcome === 'error'));
claim('no skill content stored', !skillReads.some(r => 'content' in r.data));
// Nested codemode read: available only when the bare profile leaves
// codemode callable. Absence is reported as a skip, never faked.
const outerNested = toolStartByCall.get('proof-nested');
const outerNestedEnd = endOf('proof-nested');
const innerSpanRow = toolStartByCall.get('proof-nested/1');
if (!outerNested || outerNestedEnd?.outcome !== 'ok' || !innerSpanRow) {
  console.log('SKIP nested codemode read: codemode not callable in the bare profile'
    + ` (proof-nested ${outerNested ? `ended ${outerNestedEnd?.outcome}` : 'never executed'}`
    + `${innerSpanRow ? '' : ', no nested execution span'})`);
} else {
  const nestedRead = (bySource.tool ?? []).find(r => r.data.parentToolCallId === 'proof-nested');
  claim('nested codemode read carries the real enclosing call id',
    Boolean(nestedRead && nestedRead.data.parentToolCallId === 'proof-nested'));
  claim('nested read hashes the exact text the script received',
    Boolean(nestedRead && nestedRead.data.content_sha256 === skillOrigSha
      && nestedRead.data.complete === true && nestedRead.data.range === null));
  claim('nested read joins its own execution span',
    Boolean(nestedRead && innerSpanRow && nestedRead.span === innerSpanRow.span));
}

// Custom run-pointer entries in the journals.
const pointers = sessionRecords.filter(r => r.type === 'custom' && r.customType === 'flattrace-pi/v1');
claim('run-pointer custom entries name both session runs', runs.every(r =>
  pointers.some(p => p.data?.run === r.id && p.data?.trace === r.start.trace)));

// Privacy: the canary value echoed by bash must be absent from every trace.
const canary = `canary-value-${run}-9f3c1e`;
claim('no canary value in trace bytes', !traceFiles.some(f => readFileSync(f, 'utf8').includes(canary)));
claim('no argv stored at the default level', ![...sessionRows, ...childFiles.flatMap(rowsOf)]
  .some(r => r.event === 'action'));

// Run b: nested spans plus a point through the public API, in both sessions,
// and a live annotation in the convention shape through the shared helper.
if (run === 'b') {
  const annotations = sessionRows.filter(x => x.event === 'annotation'
    && x.data.label === 'proof-second-saw-turn');
  claim('live annotation carries target/id/detector in the convention shape',
    annotations.length >= 1 && annotations.every(a =>
      typeof a.data.id === 'string' && /^[0-9a-f]{64}$/.test(a.data.id)
      && a.data.detector?.name === 'proof-second-shape' && a.data.detector?.kind === 'code'
      && a.data.target?.trace === a.trace && a.data.target?.run === a.run
      && typeof a.data.target?.span === 'string' && typeof a.data.target?.entryId === 'string'
      && typeof a.data.input_sha256 === 'string' && !('targetEntryId' in a.data)),
    `${annotations.length} annotation(s)`);
  const annotateStarts = sessionRows.filter(x => x.event === 'annotate' && x.state === 'start');
  claim('live annotate spans carry the detector object, never flat target ids',
    annotateStarts.length >= 1 && annotateStarts.every(s =>
      s.data.detector && typeof s.data.detector.name === 'string'
      && typeof s.data.input_sha256 === 'string'
      && !('targetEntryId' in s.data) && !('targetSpanId' in s.data) && !('detectorVersion' in s.data)),
    `${annotateStarts.length} annotate span(s)`);
  const nested = runs.map(r => {
    const outer = r.rows.filter(x => x.event === 'proofsecond.outer');
    return outer.filter(o => {
      if (o.state !== 'start') return false;
      const inner = r.rows.find(x => x.event === 'proofsecond.inner' && x.state === 'start' && x.parent === o.span);
      const innerEnd = inner && r.rows.find(x => x.event === 'proofsecond.inner' && x.state === 'end' && x.span === inner.span);
      const point = inner && r.rows.find(x => x.event === 'proofsecond.note' && x.state === 'point' &&
        x.data.where === 'withSpan-nested' && x.span === inner.span && x.parent === o.span);
      const outerEnd = r.rows.find(x => x.event === 'proofsecond.outer' && x.state === 'end' && x.span === o.span);
      return inner && innerEnd?.outcome === 'ok' && point && outerEnd?.outcome === 'ok';
    });
  });
  claim('both sessions carry nested public-API spans with an inner point, all ok',
    nested.every(list => list.length >= 1),
    nested.map((list, i) => `run${i}:${list.length}`).join(' '));
  claim('second extension point and detector turn observed', sessionRows.some(
    x => x.event === 'proofsecond.note') && annotations.length >= 1);
  const lateHits = sessionRecords.filter(r => JSON.stringify(r).includes('LATE_REGISTRATION_ERROR'));
  claim('late registration surfaced as an error after open', lateHits.length >= 1 &&
    lateHits.some(r => JSON.stringify(r).includes('after the writer opened')));

  // The spawned child wrote its own parented run file.
  const childRows = childFiles.flatMap(rowsOf);
  const childStart = childRows.find(r => r.event === 'run' && r.state === 'start');
  const childEnd = childRows.find(r => r.event === 'run' && r.state === 'end');
  const childHash = sha256File(childVocab);
  claim('child run envelope is proof-child and closed ok',
    Boolean(childStart && childEnd && childEnd.outcome === 'ok' &&
      childStart.tool === 'proof-child' && childStart.tool_version === '0.1.0'));
  claim('child run manifest lists the child vocabulary with its exact byte hash',
    (childStart?.data.vocabularies ?? []).some(v => v.tool === 'proof-child' && v.sha256 === childHash));
  const parentRun = runs.find(r => r.start.trace === childStart?.trace);
  const parentSpan = parentRun?.rows.find(x => x.span === childStart?.parent);
  claim('child run parents to a live span of its traceparent run',
    Boolean(childStart?.parent && parentRun && parentSpan &&
      childStart.data.parentSpan === childStart.parent),
    childStart ? `parent=${childStart.parent} trace=${String(childStart.trace).slice(0, 8)}` : 'no child start');
}

// The 0.3.0 union checker (repeatable --events) over every run file, on both
// the Rust CLI and the Python checker. Positive: each file passes with
// exactly the vocabularies its manifest lists. Negative (b only): adding an
// unlisted vocabulary file must fail and name the extra file.
const short = out => out.replace(/\s+/g, ' ').slice(0, 300);
const checkOne = (cli, file, events) => {
  const args = cli === 'rust'
    ? [rustCli, 'check', file, ...events.flatMap(e => ['--events', e])]
    : [pythonBin, '-m', 'flattrace', 'check', file, ...events.flatMap(e => ['--events', e])];
  if (!args[0]) return { ok: false, out: `${cli} checker path not provided (set PROOF_CHECK_RUST/PROOF_CHECK_PY)` };
  const done = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  const out = `${(done.stdout ?? '').trim()}${done.stderr ? `\n${String(done.stderr).trim()}` : ''}`.trim();
  return { ok: done.status === 0, out: out || `(exit ${done.status})` };
};
const positiveSets = [
  ...sessionFiles.map(f => ({ file: f, events: run === 'b' ? [ownVocab, secondVocab, convVocab] : [ownVocab, convVocab] })),
  ...(run === 'b' ? childFiles.map(f => ({ file: f, events: [childVocab, convVocab] })) : []),
];
for (const { file, events } of positiveSets) {
  const base = file.split('/').pop();
  const names = events.map(e => e.split('/').pop()).join(',');
  for (const cli of ['rust', 'python']) {
    const result = checkOne(cli, file, events);
    claim(`${cli} check passes for ${base} (--events ${names})`, result.ok, short(result.out));
  }
}
if (run === 'b') {
  for (const { file } of positiveSets.filter(s => sessionFiles.includes(s.file))) {
    const base = file.split('/').pop();
    for (const cli of ['rust', 'python']) {
      const result = checkOne(cli, file, [ownVocab, secondVocab, convVocab, lateVocab]);
      const namesExtra = /not listed|extra vocabulary/i.test(result.out);
      claim(`${cli} check fails for ${base} with the unlisted late vocabulary`, !result.ok && namesExtra,
        short(result.out));
    }
  }
}
console.log(failures ? `${failures} FAILURES` : 'ALL CLAIMS PASS');
process.exit(failures ? 1 : 0);
