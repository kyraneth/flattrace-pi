// Batch detector-run proof: a separate public Writer (never the recorder
// opens batch runs) labels one prior closed proof run through the shared
// annotate() helper. Usage: node batch-run.mjs <b-proof-root> <batch-root>.
// The batch run start links data.links [{relation: "annotates", trace, run}]
// at the target run; the run-start manifest lists the conventions vocabulary
// whose annotate/annotation declarations the checker validates against.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Writer } from 'flattrace';
import { annotate } from '../lib/annotate.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proofRoot = resolve(process.argv[2]);
const batchRoot = resolve(process.argv[3] ?? join(proofRoot, '..', 'batch'));
if (!process.argv[2]) {
  console.error('usage: node batch-run.mjs <b-proof-root> [batch-root]');
  process.exit(2);
}
mkdirSync(join(batchRoot, 'traces'), { recursive: true });

const rowsOfFile = f => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// First session run of proof b: the run start without a continuation link.
const tracesDir = join(proofRoot, 'traces');
const traceFiles = readdirSync(tracesDir).filter(f => f.endsWith('.jsonl')).map(f => join(tracesDir, f));
const starts = traceFiles.map(f => ({ file: f, start: rowsOfFile(f).find(r => r.event === 'run' && r.state === 'start') }))
  .filter(x => x.start && x.start.tool === 'proof-host');
const first = starts.find(x => !x.start.data.links);
if (!first) {
  console.error('batch: no unlinked proof-host run start found');
  process.exit(1);
}
const { trace, run } = first.start;

// The session journal that run pointer belongs to, and its first user entry.
const pointers = [];
const walk = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) {
      for (const row of rowsOfFile(p)) {
        if (row.type === 'custom' && row.customType === 'flattrace-pi/v1') pointers.push({ ...row.data, file: p });
      }
    }
  }
};
walk(join(proofRoot, 'sessions'));
const pointer = pointers.find(p => p.run === run && p.trace === trace);
if (!pointer) {
  console.error('batch: no journal run pointer found for the first run');
  process.exit(1);
}
const journal = rowsOfFile(pointer.file);
// The TOOLS prompt entry (it precedes the skill expansion), else any user entry.
const entry = journal.find(r => r.type === 'message' && r.message?.role === 'user'
  && JSON.stringify(r.message).includes('TOOLS'))
  ?? journal.find(r => r.type === 'message' && r.message?.role === 'user');
if (!entry) {
  console.error('batch: no user journal entry found');
  process.exit(1);
}
const inputSha256 = sha256(JSON.stringify(entry.message));

// The batch program's own run, through the public Writer. flattrace-pi never
// opens batch runs; the manifest lists the conventions vocabulary whose
// annotate/annotation the batch run uses.
const convFile = join(repo, 'node_modules', 'flattrace', 'schema', 'conventions-events.json');
const convSha256 = sha256(readFileSync(convFile));
process.env.FLATTRACE_DIR = join(batchRoot, 'traces');
delete process.env.FLATTRACE_TRACEPARENT;
const writer = Writer.fromEnv('proof-batch', '0.1.0', { argv: [],
  data: {
    command: 'batch',
    links: [{ relation: 'annotates', trace, run }],
    vocabularies: [{ tool: 'flattrace-conventions', version: '0.3.0', sha256: convSha256 }],
  },
});
if (!writer) {
  console.error('batch: writer did not open (tracing off or sink unavailable)');
  process.exit(1);
}
const target = { trace, run, entryId: entry.id };
const call = annotate(writer,
  { detector: { name: 'proof-batch-shape', version: '0.1.0', kind: 'code' },
    target, input_sha256: inputSha256, chunk: { entryId: entry.id },
    run: () => ({ labels: [{ label: 'batch-saw-entry', probability: null }] }) });
const settled = await call.done;
if (settled.status !== 'ok') {
  console.error(`batch: annotate settled ${settled.status}`);
  process.exit(1);
}
writer.close('ok', {});
const summary = { target: { trace, run, entryId: entry.id }, input_sha256: inputSha256,
  annotationId: call.id, status: settled.status, batchFile: writer.path,
  conventions: convFile, conventionsSha256: convSha256 };
writeFileSync(join(batchRoot, 'batch-result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
