// Public module surface of the flattrace-pi recorder.
export { RECORDER_TOOL, RECORDER_VERSION, TRACE_ENTRY } from './writer-state.mjs';
export { registerVocabulary, registerConventionsVocabulary, flattraceConventionsPath, registerDetector, registerGrader, emitPoint } from './registry.mjs';
export { annotate, annotateCurrent, annotationId } from './annotate.mjs';
export { configureHost, withSpan, beginSpan, endSpan, currentSpan, currentTraceparent, currentRun } from './public-spans.mjs';
export { traceOptIn, OPT_IN_CHANNEL } from './opt-in.mjs';
export { enableVerbosity, verbosityEnabled, TOOL_KINDS, ALLOWLIST_VERSION } from './verbosity.mjs';
export { dispatchForTurn, cancelAnnotateSpans } from './detectors.mjs';
