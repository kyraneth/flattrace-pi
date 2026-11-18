// Verify one batch detector run. Usage:
//   PROOF_CHECK_RUST=/path/to/flattrace-read-linux-x64 PROOF_CHECK_PY=/path/to/python \
//     node verify-batch.mjs <b-proof-root> <batch-root>
// Checker paths come from the environment (never baked in). The batch file
// passes both 0.3.0 checkers with repeatable --events [conventions].
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { annotationId } from '../lib/annotate.mjs';

const [proofRoot, batchRoot] = [resolve(process.argv[2]), resolve(process.argv[3])];
if (!process.argv[3]) {
  console.error('usage: node verify-batch.mjs <b-proof-root> <batch-root>');
  process.exit(2);
}
const rustCli = process.env.PROOF_CHECK_RUST ?? null;
const pythonBin = process.env.PROOF_CHECK_PY ?? null;

let failures = 0;
const claim = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const rowsOfFile = f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result = JSON.parse(readFileSync(join(batchRoot, 'batch-result.json'), 'utf8'));
const batchRows = rowsOfFile(result.batchFile);
const batchStart = batchRows.find(r => r.event === 'run' && r.state === 'start');
const batchEnd = batchRows.find(r => r.event === 'run' && r.state === 'end');

// The target is proof b's first (unlinked, closed) session run.
const bStarts = readdirSync(join(proofRoot, 'traces')).filter(f => f.endsWith('.jsonl'))
  .map(f => rowsOfFile(join(proofRoot, 'traces', f)).find(r => r.event === 'run' && r.state === 'start'))
  .filter(s => s && s.tool === 'proof-host');
const bFirst = bStarts.find(s => !s.data.links);
claim('batch links the closed proof run with relation annotates',
  Boolean(bFirst && batchStart.data.links?.length === 1
    && batchStart.data.links[0].relation === 'annotates'
    && batchStart.data.links[0].trace === bFirst.trace
    && batchStart.data.links[0].run === bFirst.run
    && result.target.trace === bFirst.trace && result.target.run === bFirst.run),
  JSON.stringify(batchStart.data.links));
claim('batch run closed ok', Boolean(batchEnd && batchEnd.outcome === 'ok'));

// Manifest lists exactly the conventions vocabulary with its exact bytes.
const convBytes = readFileSync(result.conventions);
const convSha = createHash('sha256').update(convBytes).digest('hex');
claim('batch manifest is the conventions vocabulary with its exact byte hash',
  Array.isArray(batchStart.data.vocabularies) && batchStart.data.vocabularies.length === 1
    && batchStart.data.vocabularies[0].tool === 'flattrace-conventions'
    && batchStart.data.vocabularies[0].sha256 === convSha
    && convSha === result.conventionsSha256);

// Annotation shape: convention keys, stable id, detector identity, target.
const points = batchRows.filter(r => r.event === 'annotation');
claim('one batch annotation point', points.length === 1, `got ${points.length}`);
if (points.length === 1) {
  const data = points[0].data;
  claim('annotation carries the convention keys',
    JSON.stringify(Object.keys(data).sort()) === JSON.stringify(['detector', 'id', 'input_sha256', 'label', 'probability', 'target']));
  claim('annotation detector identity is the batch detector',
    JSON.stringify(data.detector) === JSON.stringify({ name: 'proof-batch-shape', version: '0.1.0', kind: 'code' }));
  claim('annotation id is the stable recomputed id',
    typeof data.id === 'string' && data.id === annotationId(data.detector, data.target)
      && data.id === result.annotationId);
  claim('annotation target names the closed proof run entry',
    JSON.stringify(data.target) === JSON.stringify(result.target));
  claim('annotation links the input hash of the journal entry it labelled',
    typeof data.input_sha256 === 'string' && data.input_sha256 === result.input_sha256);
  claim('annotation label is the batch suggestion', data.label === 'batch-saw-entry');
}
const span = batchRows.find(r => r.event === 'annotate' && r.state === 'start');
claim('batch annotate span carries the detector object and input hash',
  Boolean(span && JSON.stringify(span.data.detector) === JSON.stringify({ name: 'proof-batch-shape', version: '0.1.0', kind: 'code' })
    && span.data.input_sha256 === result.input_sha256
    && !('targetEntryId' in span.data)));
claim('batch annotate span ended ok',
  batchRows.find(r => r.event === 'annotate' && r.state === 'end' && r.span === span?.span)?.outcome === 'ok');

// Both checkers, repeatable --events.
const short = out => out.replace(/\s+/g, ' ').slice(0, 300);
const checkOne = (cli, file) => {
  const args = cli === 'rust'
    ? [rustCli, 'check', file, '--events', result.conventions]
    : [pythonBin, '-m', 'flattrace', 'check', file, '--events', result.conventions];
  if (!args[0]) return { ok: false, out: `${cli} checker path not provided` };
  const done = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  const out = `${(done.stdout ?? '').trim()}${done.stderr ? `\n${String(done.stderr).trim()}` : ''}`.trim();
  return { ok: done.status === 0, out: out || `(exit ${done.status})` };
};
for (const cli of ['rust', 'python']) {
  const checked = checkOne(cli, result.batchFile);
  claim(`${cli} check passes for the batch run (--events conventions)`, checked.ok, short(checked.out));
}
console.log(failures ? `${failures} FAILURES` : 'ALL CLAIMS PASS');
process.exit(failures ? 1 : 0);
