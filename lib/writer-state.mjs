// Process-owned flattrace writer for this package: one writer and one run per
// process, opened on session start and closed on process quit. A session
// replacement (/new, /resume, /fork) opens a new run file linked to the one
// it replaces; the old run drains, then ends. Off unless FLATTRACE_DIR is set
// and the effective level is not 0; recorder faults never break session work
// (the helper degrades to null and latches disabled).
//
// Run-start data.env carries harness/host facts plus the Pi session id, so
// turns in the journal can be joined to spans. The trace/run ids are recorded
// in the Pi session as a custom entry (recordTraceIds), never sent to the model.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writer } from 'flattrace';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const RECORDER_TOOL = 'flattrace-pi';
export const RECORDER_VERSION = packageJson.version;
export const TRACE_ENTRY = 'flattrace-pi/v1';
export const REGISTRY_ABI = 1;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Level parsing mirrors the writer (flattrace writer levelFromEnv) and SPEC:
// trim Unicode White_Space plus U+001C-U+001F, not U+FEFF. Only ASCII digits
// 0-9 parse as a level; other values fall back to 1 with a run note.
// Unset/empty means 1; 0 means no trace I/O even with FLATTRACE_DIR set.
const levelTrimSpace = '\\p{White_Space}\\x1c-\\x1f';
const levelTrim = new RegExp(`^[${levelTrimSpace}]+|[${levelTrimSpace}]+$`, 'gu');
export function effectiveLevel() {
  const raw = (process.env.FLATTRACE_LEVEL ?? '').replace(levelTrim, '');
  if (!raw) return 1;
  const n = Number(raw);
  if (/^[0-9]+$/.test(raw) && Number.isSafeInteger(n)) return n;
  return 1;
}

function createRecorderState() {
  let writer = null;
  let warned = false;
  let closed = false;
  let accepting = true;
  let sessionState = null;
  const contexts = new AsyncLocalStorage();
  // Envelope host identity: the program that wrote the run. Default is this
  // recorder; a hosting program sets its own name at load through
  // configureHost (lib/public-spans.mjs), before the writer opens. A second
  // different host is a conflict. Vocabulary ownership stays in
  // data.vocabularies; the envelope tool names the writing program.
  let host = { tool: RECORDER_TOOL, version: RECORDER_VERSION, configured: false };
  // Span ownership: span id -> writer that opened it. Survives rotation so
  // late ends land in the run that opened the span.
  const owners = new Map();
  // Open spans per writer, for drain tracking and quit cancellation.
  const open = new Map();
  const track = (w, span) => {
    owners.set(span, w);
    let set = open.get(w);
    if (!set) open.set(w, set = new Set());
    set.add(span);
  };
  const untrack = span => {
    const w = owners.get(span);
    owners.delete(span);
    if (w) {
      const set = open.get(w);
      if (set) {
        set.delete(span);
        if (!set.size) open.delete(w);
      }
    }
    return w;
  };
  // Runs replaced by rotation: still open, taking no new spans, draining.
  const draining = [];
  // Registered vocabularies: canonical path -> {path, tool, version, sha256}.
  const vocabularies = new Map();
  // Run-owned diagnostic dedup survives same-version module re-evaluation.
  // Weak keys let closed writers and their event sets be collected.
  const undeclaredByWriter = new WeakMap();
  const detectors = [];
  const graders = [];

  // One session recorder state slot, not a registry; survives native runtime
  // replacement inside this evaluation lineage. force replaces the slot
  // (session rotation runs in a dead lineage and restarts the state).
  function sessionTraceState(create, force = false) {
    if (force || !sessionState) sessionState = create();
    return sessionState;
  }
  function withTraceContext(parent, fn) {
    if (!writer) return fn();
    return contexts.run({ parent: parent ?? currentSpan(), stack: [] }, fn);
  }
  function activeStack() { return contexts.getStore()?.stack ?? stack; }
  function currentSpan() {
    const local = contexts.getStore();
    return activeStack().at(-1) ?? local?.parent ?? stack.at(-1) ?? writer?.root ?? null;
  }
  // Latches when initialization was requested but the sink could not be opened
  // (or the inherited context was malformed). Later hooks must not retry the
  // sink: they return null without filesystem I/O. Distinct from off (DIR
  // unset or level 0), which also returns null but is not a failure. Later
  // write faults are already latched inside the writer (best-effort file
  // becomes null after one warned failure); this latch covers the open path.
  let disabled = false;
  const warnOnce = message => {
    if (warned) return;
    warned = true;
    try { console.error(`flattrace-pi: ${message}`); } catch { /* stderr must not break product work */ }
  };

  /** True when this process should trace. Two environment reads; the off switch. No filesystem I/O. */
  function traceEnabled() {
    if (disabled || closed) return false;
    if (!process.env.FLATTRACE_DIR) return false;
    return effectiveLevel() !== 0;
  }

  /** Current run writer (the active run), or null when tracing is off or draining-before-rotation. */
  function currentWriter() {
    return writer;
  }

  function vocabList() {
    return [...vocabularies.values()].map(({ tool, version, sha256: hash }) => ({ tool, version, sha256: hash }));
  }

  /**
   * Open (or reuse) this run's writer and run. Returns null when off.
   * Session replacement keeps the existing process run only when the session
   * id is unchanged; a changed session id rotates (see rotateTrace).
   * A closed process run cannot be reopened. An initialization failure
   * latches the disabled state so later hooks never touch the sink again.
   */
  function ensureTrace({ sessionId = null, harnessVersion = null, node = null,
    provider = null, model = null, requestedEffort = null, inventory = null, reason = null, links = null } = {}) {
    if (writer) return writer;
    if (disabled || closed) return null;
    if (!traceEnabled()) return null;
    let created = null;
    try {
      created = Writer.fromEnv(host.tool, host.version, {
        argv: [],
        data: {
          command: 'session',
          sessionId,
          level: effectiveLevel(),
          vocabularies: vocabList(),
          env: {
            'harness.name': 'pi',
            'harness.version': harnessVersion,
            'host.name': node,
            'gen_ai.provider.name': provider,
            'gen_ai.request.model': model,
            'model.requested_effort': requestedEffort,
            ...(reason ? { 'session.start_reason': reason } : {}),
          },
          ...(inventory ? { inventory } : {}),
          ...(links ? { links } : {}),
        },
      });
    } catch (error) {
      // Product work continues without tracing: a malformed inherited
      // context or an unavailable sink latches this run disabled (warn once).
      // Later hooks return null without touching the sink again.
      disabled = true;
      warnOnce(`tracing disabled: ${error.message}`);
      return null;
    }
    if (!created) {
      // Writer.fromEnv returns null when off (level 0 / no DIR) or when the
      // sink could not be opened. traceEnabled() was true above, so null here
      // means the sink failed: warn once and latch disabled instead of
      // retrying every hook.
      if (!traceEnabled()) return null;
      disabled = true;
      warnOnce('tracing disabled: sink unavailable');
      return null;
    }
    writer = created;
    accepting = true;
    return writer;
  }

  /**
   * Rotate to a new run file for a new session. The old run takes no new
   * spans; its still-open spans keep their real ends when observed. Returns
   * the new writer, or null when tracing is off. The old writer stays open
   * (draining) until its open set empties or the process quits.
   */
  function rotateTrace({ sessionId = null, previousSessionId = null, harnessVersion = null,
    node = null, provider = null, model = null, requestedEffort = null, inventory = null, reason = null } = {}) {
    const previous = writer;
    const previousRun = previous ? { trace: previous.trace, run: previous.run } : null;
    if (previous) {
      draining.push(previous);
      writer = null;
      // The replaced runtime is gone; its ambient synchronous parentage must
      // not leak into the new run (the writer would refuse the foreign span).
      // Late async work keeps explicit span ownership through the owner map.
      stack.length = 0;
    }
    // The replacement run continues the same process trace: parent it to the
    // old run root through the inherited context the writer itself reads.
    // The environment is restored before returning.
    let restored = false, saved = undefined;
    if (previous) {
      try {
        const parent = previous.traceparent(previous.root);
        if (typeof parent === 'string' && parent.length) {
          saved = process.env.FLATTRACE_TRACEPARENT;
          process.env.FLATTRACE_TRACEPARENT = parent;
          restored = true;
        }
      } catch { /* unparented rotation still links via data.links */ }
    }
    let next = null;
    try {
      next = ensureTrace({ sessionId, harnessVersion, node, provider, model,
        requestedEffort, inventory, reason,
        links: previousRun ? [{ relation: 'continues_process', ...previousRun }] : null });
    } finally {
      if (restored) {
        if (saved === undefined) delete process.env.FLATTRACE_TRACEPARENT;
        else process.env.FLATTRACE_TRACEPARENT = saved;
      }
    }
    if (next && previousRun) {
      // Run start already flushed with data.links above (never rewritten).
      // The bind point observes the same session change for readers.
      try {
        next.point('pi.session.bind', { sessionId, previousSessionId, reason: reason ?? null,
          runLinked: true }, next.root);
      } catch { /* best effort; rotation itself already succeeded */ }
    }
    return { writer: next, previous, previousRun };
  }

  /** Forget this run's writer (tests only). Never called on a live session. Clears latched state. */
  function resetTrace() {
    host = { tool: RECORDER_TOOL, version: RECORDER_VERSION, configured: false };
    writer = null;
    draining.length = 0;
    stack.length = 0;
    disabled = false;
    closed = false;
    warned = false;
    accepting = true;
    sessionState = null;
    owners.clear();
    open.clear();
    vocabularies.clear();
    detectors.length = 0;
    graders.length = 0;
    contexts.disable();
  }

  /** The spans enclosing the current synchronous hook, innermost last. Sync only. */
  const stack = [];

  // A replaced extension runtime loses its context, not its unfinished evidence.
  // New session work must not become a child of the abandoned runtime's last span.
  function clearTraceContext() { stack.length = 0; }

  /**
   * Open a hook span; pair with endSpan. Without an explicit parent it pushes
   * the synchronous context stack. An explicit parent creates a detached span:
   * parallel async tool/model lifetimes must never become sibling parents.
   * Null when off, when the active run is draining, or when the sink refused.
   * A draining run takes no new spans: returns null without touching any sink.
   */
  function startSpan(event, data = {}, parent = undefined) {
    if (traceEnabled() !== true || !writer || !accepting) return null;
    try {
      // The ambient parent may belong to a replaced writer (rotation keeps
      // the old run open while its runtime is gone). A span for the active
      // writer never silently parents to a foreign run: fall back to root.
      let ambient = parent ?? currentSpan();
      if (ambient !== null && ambient !== undefined && ambient !== writer.root && owners.get(ambient) !== writer) {
        ambient = writer.root;
      }
      const span = writer.start(event, data, ambient ?? currentSpan());
      track(writer, span);
      if (parent === undefined) activeStack().push(span);
      return span;
    } catch (error) {
      warnOnce(`hook span '${event}' not started: ${error.message}`);
      return null;
    }
  }

  /** Close a span opened by startSpan. An end fault leaves it unfinished. Routes to the owning writer across rotation. */
  function endSpan(span, outcome, data = {}, error = undefined) {
    if (span === null || span === undefined) return;
    const active = activeStack();
    const index = active.lastIndexOf(span);
    if (index !== -1) active.splice(index, 1);
    const owner = owners.get(span) ?? writer;
    if (!owner) {
      owners.delete(span);
      return;
    }
    try {
      let took;
      if (error === undefined) took = owner.end(span, outcome, data);
      else {
        // Error prose may contain request/result bodies or credentials. Keep
        // only stable local kinds and this recorder's declared metadata.
        const name = error?.name;
        const kinds = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError',
          'AggregateError', 'AbortError', 'TimeoutError', 'provider.error', 'http.client_error', 'http.server_error',
          'tool.error', 'compaction.error', 'detector.error'];
        took = owner.end(span, outcome, data, { kind: kinds.includes(name) ? name : 'extension.error',
          message: 'Error reported; prose deliberately excluded.' });
      }
      untrack(span);
      // A drained run whose last open span just ended can now close.
      const di = draining.indexOf(owner);
      if (di !== -1 && !open.has(owner)) {
        draining.splice(di, 1);
        try { owner.close('ok', { drained: true }); } catch { /* stays unfinished */ }
      }
      return took;
    } catch (warnError) {
      warnOnce(`hook span not ended: ${warnError.message}`);
    }
  }

  /**
   * Run fn inside a hook span. When off (or on any tracing fault) fn still
   * runs and its value/throw passes through unchanged; tracing never breaks
   * product work.
   */
  function measure(event, data, fn) {
    if (typeof fn !== 'function') throw new TypeError('measure needs a function');
    const span = startSpan(event, data);
    if (span === null) return fn();
    try {
      const value = fn();
      endSpan(span, 'ok');
      return value;
    } catch (error) {
      endSpan(span, 'error', {}, error);
      throw error;
    }
  }

  /** Emit a point on the innermost hook span (or the run root). Null when off. */
  function tracePoint(event, data = {}) {
    if (traceEnabled() !== true || !writer) return null;
    try {
      writer.point(event, data, currentSpan());
      return true;
    } catch (error) {
      warnOnce(`point '${event}' dropped: ${error.message}`);
      return null;
    }
  }

  /** W3C traceparent for the innermost hook span (or the root). Null when off. */
  function traceparent() {
    if (traceEnabled() !== true || !writer) return null;
    try {
      return writer.traceparent(currentSpan());
    } catch (error) {
      warnOnce(`traceparent unavailable: ${error.message}`);
      return null;
    }
  }

  /**
   * Child-process environment: inherits FLATTRACE_DIR/FLATTRACE_LEVEL and
   * carries FLATTRACE_TRACEPARENT. A child created with this env parents its
   * run to the passed span. Null when tracing is off.
   */
  function childEnv() {
    const parent = traceparent();
    if (!parent) return null;
    return { ...process.env, FLATTRACE_TRACEPARENT: parent };
  }

  /**
   * Record this run's trace/run ids as a native custom entry (journal fact,
   * never sent to the model). Skips when off or already recorded for this run.
   */
  function recordTraceIds(pi, ctx) {
    if (traceEnabled() !== true || !writer) return null;
    const run = writer.run, trace = writer.trace, sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    if (branch.some(e => e.type === 'custom' && e.customType === TRACE_ENTRY && e.data?.run === run && e.data?.sessionId === sessionId)) return null;
    pi.appendEntry(TRACE_ENTRY, { trace, run, path: writer.path, level: writer.level,
      sessionId, tool: RECORDER_TOOL,
      at: new Date().toISOString() });
    return { trace, run, path: writer.path };
  }

  /**
   * Close the active run and every draining run. Still-open spans end
   * cancelled first (only when cancelOpen is set, i.e. at quit). Draining
   * runs close without inventing ends for spans that never reported.
   */
  function shutdownTrace(outcome = 'ok', data = {}, cancelOpen = false) {
    closed = true;
    accepting = false;
    const active = writer;
    const writers = [...new Set([active, ...draining].filter(Boolean))];
    writer = null;
    draining.length = 0;
    stack.length = 0;
    let first = null;
    for (const w of writers) {
      let cancelled = 0;
      if (cancelOpen) {
        for (const span of [...(open.get(w) ?? [])]) {
          try { w.end(span, 'cancelled', { atQuit: true }); cancelled++; } catch { /* stays unfinished */ }
          untrack(span);
        }
      }
      try {
        // The active run closes with the caller summary; a draining run
        // closes with a drain note, never with invented ends for spans that
        // never reported.
        const endData = w === active
          ? (cancelOpen ? { ...data, cancelledAtQuit: cancelled } : data)
          : { drained: true, closedAt: 'shutdown' };
        w.close(w === active ? outcome : 'ok', endData);
        first ??= { trace: w.trace, run: w.run, path: w.path };
      } catch (error) {
        warnOnce(`run left unfinished: ${error.message}`);
      }
    }
    owners.clear();
    open.clear();
    return first;
  }

  /** The envelope host identity in force: {tool, version, configured}. */
  function hostConfig() { return { ...host }; }

  /** Set the envelope host identity (configureHost validates the phase). */
  function setHostConfig(tool, toolVersion) {
    host = { tool, version: toolVersion, configured: true };
  }

  /**
   * Run fn with an explicit span as the async parent. Spans opened inside
   * see it through currentSpan; the ambient synchronous stack is untouched.
   */
  function runInSpanContext(span, fn) {
    if (typeof fn !== 'function') throw new TypeError('flattrace-pi: runInSpanContext needs a function');
    return contexts.run({ parent: span ?? currentSpan(), stack: [] }, fn);
  }

  /** True when span is a live span opened through this recorder. */
  function ownsSpan(span) { return owners.has(span); }

  return { effectiveLevel, traceEnabled, currentWriter, ensureTrace, rotateTrace,
    resetTrace, sessionTraceState, withTraceContext, currentSpan, clearTraceContext,
    startSpan, endSpan, measure, tracePoint, traceparent, childEnv, recordTraceIds,
    shutdownTrace, vocabularies, detectors, graders, vocabList, hostConfig, setHostConfig,
    runInSpanContext, ownsSpan, undeclaredByWriter,
    setAccepting: value => { accepting = value; } };
}

const slot = Symbol.for('flattrace.pi.process');
// Same-version second evaluation (process reload of this package) reuses the
// writer; a conflicting occupant reports a conflict and opens no second writer.
const existing = globalThis[slot];
if (existing && (existing.abi !== REGISTRY_ABI || existing.tool !== RECORDER_TOOL)) {
  throw new Error(`flattrace-pi: process recorder slot already holds ${existing.tool ?? 'unknown'} ABI ${existing.abi ?? 'unknown'}; ` +
    `version ${existing.version ?? 'unknown'} conflicts with ${RECORDER_VERSION}. No second writer opened.`);
}
const shared = globalThis[slot] ??= { abi: REGISTRY_ABI, tool: RECORDER_TOOL, version: RECORDER_VERSION, state: createRecorderState() };
if (shared.version !== RECORDER_VERSION || shared.tool !== RECORDER_TOOL) {
  throw new Error(`flattrace-pi: process recorder slot holds ${shared.tool} ${shared.version}; ` +
    `this evaluation is ${RECORDER_VERSION}. No second writer opened.`);
}

export const { traceEnabled, currentWriter, ensureTrace, rotateTrace,
  resetTrace, sessionTraceState, withTraceContext, currentSpan, clearTraceContext,
  startSpan, endSpan, measure, tracePoint, traceparent, childEnv, recordTraceIds,
  shutdownTrace, vocabularies, detectors, graders, vocabList, hostConfig, setHostConfig,
  runInSpanContext, ownsSpan, undeclaredByWriter, setAccepting } = shared.state;
export const recorderSlot = shared;
