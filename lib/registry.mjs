// Extension point: other packages register event vocabularies (their own
// flattrace-events.json) and detectors/graders without forking the recorder.
//
// Names frozen by the package API test: registerVocabulary(path),
// registerDetector(entry), registerGrader(entry). Registration happens at
// extension load, before the writer opens on session start, so the run-start
// data.vocabularies is complete. A registration after the writer has opened
// throws an API error; it is never silently omitted and never rewrites the
// flushed start line. A fragment that redefines run or any pi.* event with a
// different definition is refused.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vocabularies, detectors, graders, currentWriter, traceEnabled, currentSpan, undeclaredByWriter } from './writer-state.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

function ownVocabularyPath() {
  return resolve(packageRoot, 'flattrace-events.json');
}

// Parsed once; the hash always covers the exact file bytes via a fresh read.
let ownVocabulary = null;
function ownEvents() {
  ownVocabulary ??= JSON.parse(readFileSync(ownVocabularyPath(), 'utf8'));
  return ownVocabulary;
}

const fragmentCache = new Map(); // path -> parsed events map (or null when unreadable)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Clear the fragment parse cache (tests). Registered vocabularies are untouched. */
export function resetRegistryCache() { fragmentCache.clear(); }
function fragmentDeclares(path, event) {
  if (!fragmentCache.has(path)) {
    try {
      fragmentCache.set(path, parsedVocabulary(path).parsed.events ?? {});
    } catch { fragmentCache.set(path, null); }
  }
  const events = fragmentCache.get(path);
  return events != null && Object.hasOwn(events, event) && events[event] != null;
}

/** Register this package's own vocabulary. Idempotent; called before open. A
 *  re-evaluation that finds the same file already registered is a no-op. */
export function registerOwnVocabulary() {
  const path = ownVocabularyPath();
  const existing = vocabularies.get(path);
  if (existing) return existing;
  const bytes = readFileSync(path);
  vocabularies.set(path, { path, tool: ownEvents().tool, version: recorderVersion(), sha256: sha256(bytes) });
  return vocabularies.get(path);
}

/**
 * Path of the flattrace dependency's conventions vocabulary,
 * resolved from the installed package (never vendored). The package's
 * exports map hides its package.json, so the root is found by walking up
 * from the resolved entry to the nearest package.json named flattrace.
 */
export function flattraceConventionsPath() {
  const { dirname, join } = process.getBuiltinModule('path');
  const { readFileSync: read } = process.getBuiltinModule('fs');
  const { fileURLToPath } = process.getBuiltinModule('url');
  // ESM resolution honors the package's "import" export; plain require
  // cannot see it (no CJS main). Walk up from the resolved entry file.
  let dir = dirname(fileURLToPath(import.meta.resolve('flattrace')));
  for (;;) {
    let manifest = null;
    try { manifest = JSON.parse(read(join(dir, 'package.json'), 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error; }
    if (manifest && typeof manifest === 'object' && manifest.name === 'flattrace') {
      return join(dir, 'schema', 'conventions-events.json');
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('flattrace-pi: installed flattrace package root not found above the resolved entry');
    }
    dir = parent;
  }
}

/**
 * Register the flattrace dependency's own conventions vocabulary
 * (schema/conventions-events.json: annotate, annotation, verdict, action,
 * changes). Resolved from the installed flattrace package directory, never
 * vendored: the file's tool/version/sha256 flow into the run-start
 * data.vocabularies like any other fragment, and the union checker
 * compares the exact bytes. The dependency's npm `files` list omits
 * schema/, so a fresh install needs the documented restore step (see
 * internal/DEVELOPMENT.md); a missing file throws here instead of
 * silently running without the convention names. The conventions `run`
 * is the reserved declaration, structurally equal to ours, so it registers
 * without a reserved-name refusal. Idempotent like registerOwnVocabulary.
 */
export function registerConventionsVocabulary() {
  const { existsSync: exists } = process.getBuiltinModule('fs');
  const conventionsPath = flattraceConventionsPath();
  if (!exists(conventionsPath)) {
    throw new Error(`flattrace-pi: conventions vocabulary not found at ${conventionsPath}; ` +
      `restore schema/ from the pinned accepted flattrace tarball (see internal/DEVELOPMENT.md).`);
  }
  return registerVocabulary(conventionsPath);
}

function recorderVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

// Deep structural equality of two parsed vocabulary definitions: object key
// order does not count, array order does, field descriptions count. Matches
// the union-check rule so a registration refusal predicts a checker refusal.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalize(value[k])]));
  }
  return value;
}
const sameDefinition = (a, b) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

// Walk to the filesystem root: no invented depth cap.
function nearestManifest(filePath) {
  let dir = dirname(filePath);
  for (;;) {
    let raw = null;
    try { raw = readFileSync(resolve(dir, 'package.json'), 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error; }
    if (raw !== null) {
      let manifest = null;
      try { manifest = JSON.parse(raw); } catch { throw new Error(`flattrace-pi: package.json above ${filePath} does not parse`); }
      if (typeof manifest?.name !== 'string' || !manifest.name.length) {
        throw new Error(`flattrace-pi: package.json above ${filePath} has no usable name`);
      }
      return { name: manifest.name, version: typeof manifest.version === 'string' ? manifest.version : null };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`flattrace-pi: no package.json found above ${filePath}; vocabularies are package-owned files`);
    dir = parent;
  }
}

function parsedVocabulary(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { throw new Error(`flattrace-pi: vocabulary file unreadable: ${path}: ${error.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`flattrace-pi: vocabulary file is not JSON: ${path}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || !parsed.events || typeof parsed.events !== 'object') {
    throw new Error(`flattrace-pi: vocabulary file declares no events map: ${path}`);
  }
  return { parsed, bytes: Buffer.from(raw, 'utf8') };
}

/**
 * Register one package-owned vocabulary file. The hash covers the exact file
 * bytes. Tool and version come from the nearest package.json above the file.
 * Throws when the writer is already open, when the file is unreadable, or
 * when it redefines run or pi.* differently from this recorder's declaration.
 */
export function registerVocabulary(path) {
  if (typeof path !== 'string' || !path.length) throw new Error('flattrace-pi: registerVocabulary needs a file path');
  const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(resolved)) throw new Error(`flattrace-pi: vocabulary file not found: ${resolved}`);
  const { parsed, bytes } = parsedVocabulary(resolved);
  const manifest = nearestManifest(resolved);
  const hash = sha256(bytes);
  // Byte-identical re-registration (process reload re-evaluating the same
  // file) is a no-op, even after the writer opened: nothing new is declared.
  const prior = vocabularies.get(resolved);
  if (prior && prior.sha256 === hash) return prior;
  if (currentWriter()) {
    throw new Error(`flattrace-pi: registerVocabulary(${resolved}) after the writer opened; ` +
      `vocabularies register at extension load, before session start. The run-start vocabulary list is already flushed and is never rewritten.`);
  }
  for (const name of Object.keys(parsed.events)) {
    const ours = ownEvents().events[name];
    const reserved = name === 'run' || name.startsWith('pi.');
    if (reserved && ours && !sameDefinition(ours, parsed.events[name])) {
      throw new Error(`flattrace-pi: vocabulary ${resolved} redefines '${name}' differently from the flattrace-pi declaration; ` +
        `fragments may add their own events but must not change reserved ones.`);
    }
    if (reserved && !ours) {
      throw new Error(`flattrace-pi: vocabulary ${resolved} declares reserved '${name}' unknown to this recorder; ` +
        `fragments may add their own events but must not claim reserved names.`);
    }
  }
  vocabularies.set(resolved, { path: resolved, tool: parsed.tool ?? manifest.name, version: manifest.version, sha256: hash });
  fragmentCache.delete(resolved);
  return { tool: parsed.tool ?? manifest.name, version: manifest.version, sha256: hash };
}

const validKinds = ['model', 'code', 'human'];
function checkPlugin(entry, role) {
  if (!entry || typeof entry !== 'object') throw new Error(`flattrace-pi: register${role} needs an entry object`);
  const { name, version, kind, run } = entry;
  if (typeof name !== 'string' || !name.length) throw new Error(`flattrace-pi: register${role} needs a name`);
  if (typeof version !== 'string' || !version.length) throw new Error(`flattrace-pi: register${role} needs a version`);
  if (!validKinds.includes(kind)) throw new Error(`flattrace-pi: register${role} kind must be one of ${validKinds.join('/')}`);
  if (typeof run !== 'function') throw new Error(`flattrace-pi: register${role} needs a run function`);
  const table = role === 'Detector' ? detectors : graders;
  const prior = table.findIndex(p => p.name === name);
  if (prior !== -1 && table[prior].version === version && table[prior].kind === kind) {
    // Idempotent re-registration (extension factories re-run on session
    // rotation): the same contract replaces the call even after the writer
    // opened, changing nothing about the run. A changed contract or a new
    // name after open is still an error below.
    table[prior] = { name, version, kind, questions: entry.questions ?? null, run };
    return name;
  }
  if (currentWriter()) {
    if (prior !== -1) {
      throw new Error(`flattrace-pi: register${role}(${name}) redefines version/kind after the writer opened; ` +
        `${role}s register at extension load, before session start.`);
    }
    throw new Error(`flattrace-pi: register${role}(${name}) after the writer opened; ` +
      `${role}s register at extension load, before session start.`);
  }
  // A process reload re-evaluates the same entry: same name replaces the
  // stored call, it never opens a second registration.
  const checked = { name, version, kind, questions: entry.questions ?? null, run };
  if (prior !== -1) table[prior] = checked;
  else table.push(checked);
  return checked.name;
}

/** Register a detector: run({target, input_sha256, chunk}) -> {labels} or {refused}. */
export function registerDetector(entry) {
  return checkPlugin(entry, 'Detector');
}

/** Register a grader: run({target, input_sha256, chunk}) -> verdict fields or {refused}. */
export function registerGrader(entry) {
  return checkPlugin(entry, 'Grader');
}

/** True when event is declared by the own vocabulary or a registered fragment. */
export function isDeclared(event) {
  const events = ownEvents().events;
  if (Object.hasOwn(events, event) && events[event] != null) return true;
  for (const { path } of vocabularies.values()) {
    if (path === ownVocabularyPath()) continue;
    if (fragmentDeclares(path, event)) return true;
  }
  return false;
}

/**
 * Throw unless event is declared by a registered vocabulary (union check,
 * flattrace#10). Used by strict mode, including when recording is off.
 */
export function assertDeclared(event, caller = 'emitPoint') {
  if (typeof event !== 'string' || !event.length) throw new Error(`flattrace-pi: ${caller} needs an event name`);
  if (!isDeclared(event)) throw new Error(`flattrace-pi: ${caller}('${event}') is not declared by any registered vocabulary`);
}

/** Runtime vocabulary gate: off skips all checks; strict restores errors. */
export function admitEvent(event, api) {
  if (process.env.FLATTRACE_PI_STRICT === '1') assertDeclared(event, api);
  const writer = currentWriter();
  if (!traceEnabled() || !writer) return false;
  if (isDeclared(event)) return true;
  // Invalid event arguments remain programming errors when recording is on.
  if (typeof event !== 'string' || !event.length) assertDeclared(event, api);
  let seen = undeclaredByWriter.get(writer);
  if (!seen) undeclaredByWriter.set(writer, seen = new Map());
  let apis = seen.get(event);
  if (!apis) seen.set(event, apis = new Set());
  if (!apis.has(api)) {
    apis.add(api);
    try { writer.point('pi.trace.undeclared', { event, api }, currentSpan()); }
    catch { /* diagnostics must never break the host */ }
  }
  return false;
}

/**
 * Emit a point for a third-party vocabulary event. Refuses names outside the
 * registered union (own plus fragments); refuses everything when off.
 */
export function emitPoint(event, data = {}, span = undefined) {
  if (!admitEvent(event, 'emitPoint')) return null;
  try {
    currentWriter().point(event, data, span ?? currentSpan());
    return true;
  } catch (error) {
    throw new Error(`flattrace-pi: emitPoint('${event}') dropped: ${error.message}`);
  }
}

// The documented process-global handle. Other packages' extensions reach the
// registry through this object at load time; no cross-package import needed.
// Additive so lib/public-spans.mjs can attach beside these in any order.
Object.assign(globalThis.__flattrace_pi ??= {}, {
  registerVocabulary,
  registerConventionsVocabulary,
  registerDetector,
  registerGrader,
  emitPoint,
  version: recorderVersion(),
});
