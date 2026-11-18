// Shared annotation helper: one implementation for live detector/grader
// dispatch and for batch or late detector runs over closed runs.
//
// A batch or late run is its own run, written through the public flattrace
// Writer by the program that runs it — flattrace-pi never opens batch runs.
// That run links each target with run-start
// data.links [{relation: "annotates", trace, run}]. Each label call goes
// through annotate(): it writes the annotate span and the annotation (or
// verdict) points under it, and ends the span ok, refused, error or
// cancelled honestly.
//
// Shapes follow the flattrace convention (docs/learning.md, "Detectors,
// annotations, actions and changes" in the accepted 0.3.0 source):
// - annotate span data: {detector: {name, version, kind}, questions?,
//   input_sha256, usage, cost} (usage/cost null when unknown).
// - annotation point data: {target, id, detector, label, probability,
//   input_sha256} with optional supersedes. target names the annotated
//   occurrence: {trace, run, span?, entryId?, t_from?, t_to?, seq?}.
//   id is stable across re-labels; supersedes names the replaced
//   annotation id explicitly, never by last-wins.
// - detector/grader kind is model, code or human, never a guess.
// - a grader outcome settles as a verdict point in the convention shape
//   {correct, grader: {name, version, kind}, name, reason, reward, run,
//   score, span, trace}, flattened from the same target.
import { createHash } from 'node:crypto';
import { currentWriter, traceEnabled } from './writer-state.mjs';

const DETECTOR_KINDS = new Set(['model', 'code', 'human']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalize(value[k])]));
  }
  return value;
}

/**
 * Stable annotation id across re-labels: SHA-256 over the canonical
 * detector identity plus the annotated target. Re-running the same detector
 * over the same target reproduces the id; a re-label from another detector
 * (or version) names this id in supersedes.
 */
export function annotationId(detector, target) {
  const canonical = JSON.stringify(canonicalize({
    detector: { name: detector.name, version: detector.version, kind: detector.kind }, target }));
  return createHash('sha256').update(canonical).digest('hex');
}

function checkDetector(detector) {
  if (!detector || typeof detector !== 'object') {
    throw new TypeError('flattrace-pi annotate needs a detector {name, version, kind}');
  }
  for (const key of ['name', 'version']) {
    if (typeof detector[key] !== 'string' || !detector[key].length) {
      throw new TypeError(`flattrace-pi annotate needs a detector with a non-empty ${key}`);
    }
  }
  if (!DETECTOR_KINDS.has(detector.kind)) {
    throw new TypeError(`flattrace-pi annotate detector kind must be one of model/code/human, got ${JSON.stringify(detector.kind)}`);
  }
  return { name: detector.name, version: detector.version, kind: detector.kind };
}

function checkTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new TypeError('flattrace-pi annotate needs a target {trace, run, span?, entryId?, ...}');
  }
  for (const key of ['trace', 'run']) {
    if (typeof target[key] !== 'string' || !target[key].length) {
      throw new TypeError(`flattrace-pi annotate needs a target with a non-empty ${key}`);
    }
  }
  return target;
}

const endData = (detector, input_sha256, outcome) => {
  const usage = outcome?.usage;
  const cost = outcome?.cost;
  return { detector, input_sha256,
    usage: usage && typeof usage === 'object' ? usage : null,
    cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null };
};

// Best-effort end: the span may already be ended (the recorder ends
// in-flight spans cancelled at quit). A second end must not throw.
function tryEnd(writer, span, outcome, data, error = undefined) {
  try {
    if (error === undefined) writer.end(span, outcome, data);
    else writer.end(span, outcome, data, error);
    return true;
  } catch { return false; }
}

// Best-effort point under a span that may already have ended: Writer.point
// degrades to the run root with a late_span note instead of throwing.
function tryPoint(writer, event, data, span) {
  try {
    writer.point(event, data, span);
    return true;
  } catch { return false; }
}

/**
 * Run one detector/grader call and record it on any flattrace Writer.
 *
 * writer: any flattrace Writer (live run writer, or a separate batch-run
 * writer opened by the calling program). detector: {name, version, kind}.
 * target: {trace, run, span?, entryId?, t_from?, t_to?, seq?}.
 * input_sha256: fingerprint of the detector input, or null when unavailable
 * (with explicit coverage in the caller, never invented). chunk: the
 * labelled unit's context passed to run (entry/span pointers, the entry
 * bytes, …); passed through, never stored. run: the detector/grader call,
 * receiving {target, input_sha256, chunk} and returning (or resolving to)
 * {labels: [{label, probability|null}]} (detector), verdict fields
 * {correct, score, reward, reason} (grader), {refused: true, reason} or
 * {cancelled: true}. questions and supersedes are optional extras.
 *
 * Returns {span, id, done}: the annotate span id, the stable annotation id,
 * and a promise resolving to {status, span, id} with status ok, refused,
 * error or cancelled. The span opens synchronously, so a live dispatcher
 * can track it for at-quit cancellation before done settles. Synchronous
 * misuse (bad detector/target/run, unusable writer, refused span) throws;
 * settlement itself never throws.
 */
export function annotate(writer, { detector, target, input_sha256 = null, chunk = null,
  run, questions = null, supersedes = null } = {}) {
  const identity = checkDetector(detector);
  const occurrence = checkTarget(target);
  if (typeof run !== 'function') {
    throw new TypeError('flattrace-pi annotate needs a run function');
  }
  if (!writer || typeof writer.start !== 'function' || typeof writer.point !== 'function'
    || typeof writer.end !== 'function') {
    throw new TypeError('flattrace-pi annotate needs a flattrace Writer');
  }
  const id = annotationId(identity, occurrence);
  const span = writer.start('annotate',
    { detector: identity, ...(questions != null ? { questions } : {}), input_sha256 });

  const done = (async () => {
    let outcome;
    try {
      outcome = await run({ target: occurrence, input_sha256, chunk });
    } catch (error) {
      tryEnd(writer, span, 'error', endData(identity, input_sha256, null),
        { kind: 'detector.error', message: 'Detector call threw; error prose deliberately excluded.' });
      return { status: 'error', span, id };
    }
    if (outcome && typeof outcome === 'object' && outcome.cancelled === true) {
      tryEnd(writer, span, 'cancelled', { detector: identity, input_sha256 });
      return { status: 'cancelled', span, id };
    }
    if (outcome && typeof outcome === 'object' && outcome.refused === true) {
      const reason = typeof outcome.reason === 'string' ? outcome.reason : null;
      tryEnd(writer, span, 'refused', { ...endData(identity, input_sha256, null), refusalReason: reason });
      return { status: 'refused', span, id };
    }
    if (outcome && typeof outcome === 'object' && Array.isArray(outcome.labels)) {
      for (const { label, probability } of outcome.labels) {
        tryPoint(writer, 'annotation', { target: occurrence, id, detector: identity,
          label: typeof label === 'string' ? label : null,
          probability: typeof probability === 'number' && Number.isFinite(probability) ? probability : null,
          input_sha256, ...(supersedes ? { supersedes } : {}) }, span);
      }
      tryEnd(writer, span, 'ok', endData(identity, input_sha256, outcome));
      return { status: 'ok', span, id };
    }
    if (outcome && typeof outcome === 'object' && ('correct' in outcome || 'score' in outcome)) {
      const pick = value => value === undefined ? null : value;
      tryPoint(writer, 'verdict', { correct: pick(outcome.correct), score: pick(outcome.score),
        reward: pick(outcome.reward ?? null), reason: typeof outcome.reason === 'string' ? outcome.reason : null,
        name: identity.name, grader: identity,
        run: occurrence.run, trace: occurrence.trace, span: occurrence.span ?? null }, span);
      tryEnd(writer, span, 'ok', endData(identity, input_sha256, outcome));
      return { status: 'ok', span, id };
    }
    tryEnd(writer, span, 'error', endData(identity, input_sha256, null),
      { kind: 'detector.error', message: 'Detector returned no labels or verdict fields; outcome prose deliberately excluded.' });
    return { status: 'error', span, id };
  })();

  return { span, id, done };
}

/**
 * Annotate an occurrence in the active run, without exposing its writer or
 * dispatching registered detectors. Missing target trace/run come from that
 * writer; explicitly foreign identities are API errors. Supply either labels
 * already computed by the caller or one run callback, never both. Callback
 * usage/cost take precedence over the optional call-level values.
 * Returns annotate's {span, id, done}, or null without I/O or callback execution
 * when tracing is off or no run is active. Never opens a writer itself.
 */
export function annotateCurrent({ detector, target = {}, input_sha256 = null,
  labels, run, usage = null, cost = null, ...options } = {}) {
  if (!traceEnabled()) return null;
  const writer = currentWriter();
  if (!writer) return null;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('flattrace-pi annotateCurrent needs a target object');
  }
  for (const key of ['trace', 'run']) {
    if (target[key] !== undefined && target[key] !== writer[key]) {
      throw new TypeError(`flattrace-pi annotateCurrent target ${key} must name the active run`);
    }
  }
  if ((labels !== undefined) === (run !== undefined)
    || (labels !== undefined && !Array.isArray(labels))
    || (run !== undefined && typeof run !== 'function')) {
    throw new TypeError('flattrace-pi annotateCurrent needs either labels or a run function');
  }
  return annotate(writer, { ...options, detector, input_sha256,
    target: { ...target, trace: writer.trace, run: writer.run },
    run: run === undefined ? () => ({ labels, usage, cost }) : async context => {
      const outcome = await run(context);
      return outcome && typeof outcome === 'object' ? { usage, cost, ...outcome } : outcome;
    } });
}

// The documented process-global handle, beside the registry and span APIs:
// batch and late detector runs reach the same helper without importing.
Object.assign(globalThis.__flattrace_pi ??= {}, { annotate, annotateCurrent, annotationId });
