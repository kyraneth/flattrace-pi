// flattrace-pi Pi extension entry. One process-owned writer; a session
// replacement reuses it for the same session and rotates it for a new one.
// Off unless FLATTRACE_DIR is set and the effective level is not 0; recorder
// faults never break session work.
import { registerWorkTrace } from '../lib/work-trace.mjs';
import { registerOwnVocabulary, registerConventionsVocabulary } from '../lib/registry.mjs';
import '../lib/public-spans.mjs'; // attach the public span API to the process handle
import { enableVerbosity } from '../lib/verbosity.mjs';
import * as trace from '../lib/writer-state.mjs';

export default function flattracePiExtension(pi) {
  // Vocabulary registration happens at load, before the writer opens on
  // session start. The opt-in verbosity fragment registers only at level 2+.
  // The dependency's conventions vocabulary declares the shared annotate /
  // annotation / verdict names this package's own vocabulary no longer
  // repeats; a missing conventions file warns loudly instead of running
  // without the convention names.
  try { registerOwnVocabulary(); } catch { /* surfacing happens at session start */ }
  try { registerConventionsVocabulary(); } catch (error) {
    try { console.error(`flattrace-pi: conventions vocabulary not registered: ${error?.message ?? error}`); } catch { /* stderr must not break product work */ }
  }
  try { enableVerbosity(); } catch { /* level < 2 is a no-op, never a failure */ }
  const work = registerWorkTrace(pi, trace);
  work.attach(pi);
}
