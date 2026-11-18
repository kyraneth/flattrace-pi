// Public span/context API for third-party extensions: write spans into the
// one process run, read the active context, and pass the traceparent to a
// child process. Frozen names (ISSUE3 #3): withSpan, beginSpan/endSpan,
// currentSpan, currentTraceparent, currentRun, configureHost.
//
// Context runs through AsyncLocalStorage with the same semantics as the
// internal recorder, so the names stay compatible. Events must be declared
// by a registered vocabulary (union check). With recording off, vocabulary
// checks are skipped entirely. With recording on, undeclared names return
// null (withSpan still runs fn), writing no span and one pi.trace.undeclared
// diagnostic per (event, api) per run. Only FLATTRACE_PI_STRICT=1 restores
// vocabulary errors whether recording is on or off; all other values are off.
// Other programming errors still throw. Off calls are no-ops:
// beginSpan returns null, withSpan still runs fn (with a null
// handle), endSpan(null) returns null, current* return null. Lifecycle
// failures (draining or closed run, refused sink) never throw and never break
// the host: fn still runs and its value/throw passes through unchanged.
import { currentWriter, startSpan, endSpan as endRawSpan,
  currentSpan as rawCurrentSpan, runInSpanContext, ownsSpan,
  hostConfig, setHostConfig, traceparent as rawTraceparent } from './writer-state.mjs';
import { admitEvent } from './registry.mjs';

// Opaque per-evaluation brand: only handles this module made validate.
// Handles never survive a process reload (the span context does not either).
const brand = Symbol('flattrace-pi.span');
const makeHandle = (event, span) => Object.freeze({ [brand]: true, event: event ?? null, span });

function needSpan(value, what) {
  if (value && typeof value === 'object' && value[brand] === true && typeof value.span === 'string') return value;
  throw new TypeError(`flattrace-pi: ${what} must be a span handle from beginSpan, withSpan or currentSpan`);
}

// The writer itself requires a lowercase slug for the envelope tool
// (it becomes part of the run file name); fail fast with the rule beside it.
const toolPattern = /^[a-z0-9_-]+$/;

/**
 * Name the program that writes the run file. Runs at load, before the writer
 * opens, with the same phase rule as vocabulary registration: configuring
 * after the writer opened is an API error. Default is flattrace-pi with the
 * package version. One host per process: repeating the same host is a no-op
 * (extension factories re-run on session rotation with the previous run
 * still open); configuring a first host after open, or changing it at any
 * time, is an error.
 * Vocabulary ownership stays in data.vocabularies; the envelope tool names
 * the writing program.
 */
export function configureHost({ tool, toolVersion } = {}) {
  if (typeof tool !== 'string' || !toolPattern.test(tool)) {
    throw new Error(`flattrace-pi: configureHost needs a lowercase-slug tool name ([a-z0-9_-]+), ` +
      `got ${typeof tool === 'string' ? JSON.stringify(tool) : typeof tool}`);
  }
  if (typeof toolVersion !== 'string' || !toolVersion.length) {
    throw new Error('flattrace-pi: configureHost needs a non-empty toolVersion string');
  }
  const prior = hostConfig();
  // Idempotent repeat (extension factories re-run on session rotation with
  // the previous run still open): the same host changes nothing and is a
  // no-op even after the writer opened. Any change is a conflict error.
  if (prior.configured && prior.tool === tool && prior.version === toolVersion) {
    return { tool, toolVersion };
  }
  if (currentWriter()) {
    throw new Error(`flattrace-pi: configureHost(${tool}@${toolVersion}) after the writer opened; ` +
      `the host envelope is fixed at load, before session start, and is never rewritten.`);
  }
  if (prior.configured) {
    throw new Error(`flattrace-pi: host conflict: already configured as ${prior.tool}@${prior.version}, ` +
      `refusing ${tool}@${toolVersion}. One host per process.`);
  }
  setHostConfig(tool, toolVersion);
  return { tool, toolVersion };
}

/**
 * Open a span for a declared event. Returns an opaque handle, or null when
 * tracing is off, the run is draining, or the sink refused (never throws for
 * lifecycle or vocabulary reasons, except in strict mode). options.parent selects the
 * parent: omitted means the ambient context (tracked like an internal span),
 * null means the run root, a handle means that span (a stale or foreign span
 * falls back to the root, never to another run).
 */
export function beginSpan(event, data = {}, options = {}) {
  const { parent = undefined } = options ?? {};
  let rawParent;
  if (parent === undefined) rawParent = undefined;
  else if (parent === null) rawParent = currentWriter()?.root;
  else rawParent = needSpan(parent, 'beginSpan parent').span;
  if (!admitEvent(event, 'beginSpan')) return null;
  const span = startSpan(event, data ?? {}, rawParent);
  if (span === null) return null;
  return makeHandle(event, span);
}

/**
 * Close a span opened by beginSpan (or observed via currentSpan). Safe on a
 * draining or closed run, following the late-span rule: the end routes to
 * the run that opened the span, and faults end unfinished without throwing.
 * A null handle is a no-op returning null. A foreign value throws TypeError;
 * a non-string outcome throws TypeError.
 */
export function endSpan(handle, outcome, data = {}) {
  if (handle === null || handle === undefined) return null;
  const { span } = needSpan(handle, 'endSpan handle');
  if (typeof outcome !== 'string' || !outcome.length) {
    throw new TypeError('flattrace-pi: endSpan needs a string outcome');
  }
  return endRawSpan(span, outcome, data ?? {}) ?? null;
}

/**
 * The innermost live span as a handle, or null when tracing is off or no
 * tracked span is open (the run root itself is not a handle).
 */
export function currentSpan() {
  const raw = rawCurrentSpan();
  if (typeof raw !== 'string' || !ownsSpan(raw)) return null;
  return makeHandle(null, raw);
}

/** W3C traceparent string for the innermost span (or the root). Null when off. */
export function currentTraceparent() {
  return rawTraceparent();
}

/** The active run {trace, run}, or null when tracing is off. */
export function currentRun() {
  const writer = currentWriter();
  if (!writer) return null;
  return { trace: writer.trace, run: writer.run };
}

function reportedOutcome(result) {
  if (typeof result === 'string' && result.length) return { outcome: result, data: {} };
  if (result && typeof result === 'object' && typeof result.outcome === 'string' && result.outcome.length) {
    return { outcome: result.outcome,
      data: result.data && typeof result.data === 'object' ? result.data : {} };
  }
  // No invented ok: a callback that reports nothing ends unknown.
  return { outcome: 'unknown', data: {} };
}

/**
 * Run fn inside a span for a declared event (async). The callback receives
 * the span handle (null when tracing is off) and its return value passes
 * through unchanged. The span ends with the outcome the callback reports —
 * a string return, or {outcome, data} — or `unknown` when it reports none,
 * and `error` when it throws (the error is rethrown with prose excluded from
 * the trace, as with internal spans).
 */
export function withSpan(event, data, fn) {
  if (typeof data === 'function' && fn === undefined) { fn = data; data = {}; }
  if (typeof fn !== 'function') throw new TypeError('flattrace-pi: withSpan needs a function');
  // Off, undeclared, or draining/closed: fn still runs with a null handle.
  if (!admitEvent(event, 'withSpan')) return fn(null);
  const span = startSpan(event, data ?? {});
  if (span === null) return fn(null);
  const handle = makeHandle(event, span);
  return (async () => {
    try {
      const result = await runInSpanContext(span, () => fn(handle));
      const reported = reportedOutcome(result);
      endRawSpan(span, reported.outcome, reported.data);
      return result;
    } catch (error) {
      endRawSpan(span, 'error', {}, error);
      throw error;
    }
  })();
}

// The documented process-global handle: other packages reach the public span
// API through this object at load time, beside the registry functions.
Object.assign(globalThis.__flattrace_pi ??= {},
  { configureHost, withSpan, beginSpan, endSpan, currentSpan, currentTraceparent, currentRun });
