// Detector/grader dispatch: each registered call runs inside its own annotate
// span through the shared annotate() helper (lib/annotate.mjs) — the same
// function batch and late runs use. Dispatch never blocks the turn
// (sync entry, async settlement) and close never waits: in-flight calls end
// cancelled at shutdown.
import { createHash } from 'node:crypto';
import { annotate } from './annotate.mjs';
import { detectors, graders, currentWriter } from './writer-state.mjs';

// span -> {writer, detector, detectorVersion, kind} for at-quit cancellation.
const inFlight = new Map();

const sha256 = value => createHash('sha256').update(value).digest('hex');

function entryInputSha(getEntry, entryId) {
  if (!getEntry || !entryId) return null;
  try {
    const entry = getEntry(entryId);
    if (!entry) return null;
    return sha256(JSON.stringify(entry.message ?? entry));
  } catch { return null; }
}

/** End every in-flight annotate span cancelled. Called at quit; never waits for the calls. */
export function cancelAnnotateSpans() {
  for (const [span, tracked] of [...inFlight]) {
    inFlight.delete(span);
    try {
      tracked.writer.end(span, 'cancelled',
        { detector: { name: tracked.detector, version: tracked.detectorVersion, kind: tracked.kind },
          input_sha256: tracked.input_sha256 ?? null, atQuit: true });
    } catch { /* stays unfinished */ }
  }
}

/**
 * Dispatch every registered detector and grader for one settled turn. Sync
 * entry, async settlement: returns the number of annotate spans opened;
 * results land as annotation / verdict points under per-call annotate spans.
 * Never throws.
 */
export function dispatchForTurn({ entryId = null, turnSpanId = null, getEntry = null } = {}) {
  const writer = currentWriter();
  if (!writer) return 0;
  const plugins = [...detectors.map(p => ({ ...p, role: 'detector' })), ...graders.map(p => ({ ...p, role: 'grader' }))];
  if (!plugins.length) return 0;
  const inputHash = entryInputSha(getEntry, entryId);
  let started = 0;
  for (const plugin of plugins) {
    const target = { trace: writer.trace, run: writer.run,
      ...(turnSpanId ? { span: turnSpanId } : {}), ...(entryId ? { entryId } : {}) };
    let call = null;
    try {
      call = annotate(writer, { detector: { name: plugin.name, version: plugin.version, kind: plugin.kind },
        target, input_sha256: inputHash,
        ...(plugin.questions != null ? { questions: plugin.questions } : {}),
        chunk: { ...(entryId ? { entryId } : {}), ...(turnSpanId ? { span: turnSpanId } : {}) },
        run: plugin.run });
    } catch { continue; }
    if (!call || !call.span) continue;
    started++;
    inFlight.set(call.span, { writer, detector: plugin.name, detectorVersion: plugin.version,
      kind: plugin.kind, input_sha256: inputHash });
    call.done.then(
      () => { inFlight.delete(call.span); },
      () => { inFlight.delete(call.span); });
  }
  return started;
}
