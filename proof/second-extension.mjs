// Second generic extension for the live proof: registers its own vocabulary
// and a code detector at load (before the writer opens), configures the host
// envelope (standing in for the hosting program), then per settled activity
// emits one vocabulary point plus a nested span pair through the public span
// API, and once passes the current traceparent to a spawned child process
// that writes its own parented run file.
import { spawnSync } from 'node:child_process';

// One child per process trace: extension modules may be re-evaluated on
// session rotation, so a module-level flag alone could spawn twice.
const spawnedForTrace = globalThis.__proof_second_child_for ??= {};

export default function (pi) {
  const registry = globalThis.__flattrace_pi;
  if (!registry) throw new Error('proof-second: flattrace-pi must load before this extension');
  // This extension stands in for the hosting program: it names the run
  // envelope at load, before the writer opens.
  registry.configureHost({ tool: 'proof-host', toolVersion: '0.1.0' });
  registry.registerVocabulary(process.env.PROOF_SECOND_VOCAB);
  registry.registerDetector({ name: 'proof-second-shape', version: '0.1.0', kind: 'code',
    run: () => ({ labels: [{ label: 'proof-second-saw-turn', probability: null }] }) });
  pi.on('agent_settled', async () => {
    try { registry.emitPoint('proofsecond.note', { where: 'agent_settled' }); } catch { /* best effort */ }
    try {
      await registry.withSpan('proofsecond.outer', { where: 'agent_settled' }, async () => {
        await registry.withSpan('proofsecond.inner', { where: 'nested' }, async () => {
          registry.emitPoint('proofsecond.note', { where: 'withSpan-nested' });
          const current = registry.currentRun();
          if (current && !spawnedForTrace[current.trace]) {
            spawnedForTrace[current.trace] = true;
            const childScript = process.env.PROOF_CHILD_SCRIPT;
            const traceparent = registry.currentTraceparent();
            if (childScript && traceparent) {
              const child = spawnSync(process.execPath, [childScript], {
                env: { ...process.env, FLATTRACE_TRACEPARENT: traceparent },
                stdio: ['ignore', 'pipe', 'inherit'],
              });
              if (child.status !== 0) {
                delete spawnedForTrace[current.trace];
                console.error(`proof-second: child run failed: status=${child.status} ` +
                  `${(child.stdout ?? '').toString().trim()} ${(child.error?.message ?? '')}`);
              }
            } else {
              delete spawnedForTrace[current.trace];
            }
          }
          return 'ok';
        });
        return 'ok';
      });
    } catch { /* tracing must not break the session */ }
  });
}
