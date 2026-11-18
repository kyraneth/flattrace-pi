// Proof-only child process for run b: writes its own run file parented to the
// span id passed via FLATTRACE_TRACEPARENT (set by the second extension from
// currentTraceparent around a nested withSpan span). Uses the flattrace
// writer's fromEnv directly, like any hosting program would.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Writer } from 'flattrace';

const vocabPath = process.env.PROOF_CHILD_VOCAB;
if (!vocabPath) {
  console.error('child: PROOF_CHILD_VOCAB is not set');
  process.exit(2);
}
const convPath = process.env.PROOF_CONV_VOCAB;
if (!convPath) {
  console.error('child: PROOF_CONV_VOCAB is not set');
  process.exit(2);
}
const vocabBytes = readFileSync(vocabPath);
const sha256 = createHash('sha256').update(vocabBytes).digest('hex');
const convBytes = readFileSync(convPath);
const convSha256 = createHash('sha256').update(convBytes).digest('hex');

const inherited = process.env.FLATTRACE_TRACEPARENT ?? '';
const parentSpan = /^00-[0-9a-f]{32}-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(inherited)?.[1] ?? null;

const writer = Writer.fromEnv('proof-child', '0.1.0', {
  data: {
    command: 'proof-child',
    parentSpan,
    vocabularies: [{ tool: 'proof-child', version: '0.1.0', sha256 },
      { tool: 'flattrace-conventions', version: '0.3.0', sha256: convSha256 }],
  },
});
if (!writer) {
  console.error('child: writer did not open (tracing off or sink unavailable)');
  process.exit(2);
}
const span = writer.start('proofchild.work', { parentSpan, parentTrace: writer.trace });
writer.end(span, 'ok', {});
writer.close('ok', {});
console.log(JSON.stringify({ trace: writer.trace, parent: writer.parent, run: writer.run, path: writer.path }));
