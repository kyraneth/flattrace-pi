// Opt-in verbosity module: `action` points, one known fact per tool call.
// Off by default. Enabled only when the process level is 2 or higher, in
// which case the verbosity vocabulary fragment registers at load (before the
// writer opens) and tool calls emit action points.
//
// kind comes only from the named, versioned allowlist of Pi built-in tools
// below (else null, never a guess). argv passes the writer's sanitizeArgv
// plus tool-specific redaction: only scalar path-like parameters are kept;
// free-text parameters are never stored and their names are listed in
// withheldParams so the omission is explicit.
import { sanitizeArgv } from 'flattrace';
import { registerVocabulary } from './registry.mjs';
import { effectiveLevel, currentWriter, currentSpan } from './writer-state.mjs';
import { fileURLToPath } from 'node:url';

export const ALLOWLIST_VERSION = '1.4.0';
export const TOOL_KINDS = new Map(Object.entries({
  read: 'read',
  edit: 'edit',
  write: 'write',
  bash: 'exec',
  powershell: 'exec',
  grep: 'read',
  find: 'read',
  ls: 'read',
}));

// Free-text parameter names: never stored, only named. Case-sensitive native
// tool input keys.
const WITHHELD_KEYS = new Set(['command', 'content', 'text', 'body', 'prompt',
  'message', 'messages', 'args', 'arguments', 'input', 'payload', 'data',
  'details', 'systemPrompt', 'template', 'script']);

let enabled = false;

function vocabularyPath() {
  return fileURLToPath(new URL('../vocabularies/verbosity.json', import.meta.url));
}

/**
 * Enable the verbosity module when the process level allows it. Called once
 * at extension load (before the writer opens). Returns true when enabled.
 * At level < 2 this is a no-op: nothing is declared and nothing is stored.
 */
export function enableVerbosity() {
  if (enabled) return true;
  if (effectiveLevel() < 2) return false;
  registerVocabulary(vocabularyPath());
  enabled = true;
  return true;
}

export function verbosityEnabled() { return enabled; }
export function resetVerbosity() { enabled = false; }

function scalarArgv(input) {
  // Scalars are carried as key=value strings so the writer's sanitizeArgv
  // sees the parameter NAME and can redact by it (a bare value alone would
  // defeat flag/assignment redaction). Only scalar path-like parameters are
  // kept; free-text parameters are withheld by name.
  const argv = [], withheld = [];
  if (!input || typeof input !== 'object') return { argv, withheld };
  for (const [key, value] of Object.entries(input)) {
    if (WITHHELD_KEYS.has(key)) { withheld.push(key); continue; }
    if (typeof value === 'string') argv.push(`${key}=${value}`);
    else if (typeof value === 'number' || typeof value === 'boolean') argv.push(`${key}=${String(value)}`);
    else if (value != null) withheld.push(key);
  }
  return { argv, withheld };
}

/**
 * Build the action point data for one tool_call event. Null when the module
 * is disabled. Never throws; a failure returns null.
 */
export function actionForToolCall(event) {
  if (!enabled || !currentWriter()) return null;
  try {
    const toolName = typeof event?.toolName === 'string' ? event.toolName : null;
    if (!toolName) return null;
    const kind = TOOL_KINDS.get(toolName) ?? null;
    const { argv, withheld } = scalarArgv(event?.input);
    return { toolCallId: event.toolCallId ?? null,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      toolName, kind, allowlistVersion: ALLOWLIST_VERSION,
      argv: sanitizeArgv(argv), withheldParams: withheld,
      redactionNote: 'writer sanitizeArgv plus scalar-only filtering; free-text parameters withheld by name' };
  } catch { return null; }
}

/** Emit the action point for one tool_call event. Null when disabled or off. */
export function emitAction(event) {
  const data = actionForToolCall(event);
  if (!data) return null;
  try {
    currentWriter().point('action', data, currentSpan());
    return true;
  } catch { return null; }
}
