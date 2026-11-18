// Committed-source inventory for native Pi tools/commands and recorder
// extensions. Facts are cached per collector instance (recreated on reload),
// never in a persistent registry: a reload must not report a stale installed
// version. No new sink, timer, retry or numerical limit; the filesystem root
// is the natural end of the manifest walk.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Pi names synthetic, file-less sources this way: `builtin:<name>` and
// `<inline:name>`/`<temporary:name>` (core/source-info). They have nothing to
// realpath, so their identity is the declared path.
const isSynthetic = value => value.startsWith('builtin:') || value.startsWith('<');
const sourceKindOf = value => typeof value !== 'string' || !value.length ? null
  : value.startsWith('builtin:') ? 'builtin'
  : value.startsWith('<') ? value.slice(1, -1).split(':')[0] || 'temporary'
  : 'extension';
const text = value => typeof value === 'string' && value.length ? value : null;
const list = value => Array.isArray(value) ? value : [];

// What this point can and cannot know. Handler-only packages that register no
// tool or command leave no trace Pi exposes, so they stay explicitly unknown.
const COVERAGE = [
  'Recorder extensions are listed when (a) their own factory requested this tracing facade, or (b) a native tool or command they registered proves the package committed.',
  '(b) resolves that registration file to its nearest package.json and reports only that package name and version.',
  'instrumented=true means the factory opted into own-handler timing; false means package-only discovery from a committed registration and never claims timing coverage.',
  'active=true for an opted factory means native session_start/before_agent_start activation was observed or an actual committed tool/extension-command matches its source; null means not yet observed, not inactive.',
  'Pi exposes no complete extension API: a handler-only package that registers no tool or command remains unavailable, and non-opted handlers are never timed.',
  'Native tool schemas, descriptions, source paths, headers, environment and payloads are excluded.'].join(' ');

export function createInventory(pi, trace, state) {
  const canonicalPaths = new Map(); // declared source -> canonical file path (or null)
  const manifests = new Map();      // canonical file path -> { name, version } | null

  const sampling = () => state.inventorySampling ??= { n: 0, failed: 0, totalMs: 0, maxMs: null };

  // Canonical identity for matching a registration to an opted descriptor.
  // file:// URLs and plain paths resolve to one realpath; synthetic paths keep
  // their declared identity. Repeat lookups (per tool, per turn) do no I/O, and
  // an unresolved source is remembered as unresolved rather than re-statted.
  const sourcePath = value => {
    if (typeof value !== 'string' || !value.length) return null;
    if (canonicalPaths.has(value)) return canonicalPaths.get(value);
    let resolved = null;
    try {
      if (isSynthetic(value)) resolved = value;
      else resolved = realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value);
    } catch { resolved = null; }
    canonicalPaths.set(value, resolved);
    return resolved;
  };

  // Nearest manifest decides ownership. Nothing else from the manifest is
  // read into the output, and no manifest path is emitted. An unparsable
  // manifest ends the walk: an outer workspace root must not be attributed to
  // another package's file.
  const manifestFor = filePath => {
    if (typeof filePath !== 'string' || !filePath.length || !isAbsolute(filePath) || isSynthetic(filePath)) return null;
    if (manifests.has(filePath)) return manifests.get(filePath);
    let found = null, dir = dirname(filePath);
    for (;;) {
      let raw = null;
      try { raw = readFileSync(join(dir, 'package.json'), 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') break; }
      if (raw !== null) {
        try {
          const manifest = JSON.parse(raw);
          const name = text(manifest?.name);
          found = name ? { name, version: text(manifest.version) } : null;
        } catch { found = null; }
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    manifests.set(filePath, found);
    return found;
  };

  const invoke = name => {
    const fn = pi?.[name];
    return typeof fn === 'function' ? fn.call(pi) : undefined;
  };

  // Pure snapshot construction. Sampling wraps this once per public entry point
  // so an emit never counts its own build twice.
  const build = ctx => {
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
    const activeValue = invoke('getActiveTools'), toolValue = invoke('getAllTools'), commandValue = invoke('getCommands');
    const availability = { activeTools: Array.isArray(activeValue), tools: Array.isArray(toolValue), commands: Array.isArray(commandValue) };
    const activeNames = availability.activeTools ? new Set(activeValue.filter(name => typeof name === 'string')) : null;
    const tools = list(toolValue), commands = list(commandValue);
    const ownersBySource = new Map();
    for (const descriptor of state.extensions?.values() ?? []) {
      const source = sourcePath(descriptor.source); if (source) ownersBySource.set(source, descriptor);
    }
    const observed = new Set();      // canonical registration files Pi actually reports
    const discovered = new Map();    // package name -> { name, version }
    const rows = [];

    const note = (rawPath, canonical) => {
      if (!canonical) return null;
      observed.add(canonical);
      const manifest = manifestFor(canonical);
      if (manifest && !discovered.has(manifest.name)) discovered.set(manifest.name, manifest);
      return manifest;
    };

    for (const tool of tools) {
      const name = text(tool?.name);
      if (!name) continue;
      const info = tool.sourceInfo ?? {};
      const canonical = sourcePath(info.path);
      const manifest = note(info.path, canonical);
      // Attribution requires a real match between native source metadata and the
      // descriptor recorded by our own factory; a same-named tool from another
      // file is never claimed by an unrelated owner.
      const owner = canonical ? ownersBySource.get(canonical) : null;
      rows.push({ name, active: activeNames ? activeNames.has(name) : null, exposure: tool.exposure ?? null,
        extension: owner?.name ?? manifest?.name ?? null,
        extensionVersion: owner?.version ?? manifest?.version ?? null,
        sourceKind: sourceKindOf(info.path), sourceScope: info.scope ?? null, sourceOrigin: info.origin ?? null });
    }
    // A prompt/skill command proves a resource package, not an active JS
    // extension. Only native extension commands establish extension presence.
    for (const command of commands) if (command?.source === 'extension') note(command?.sourceInfo?.path, sourcePath(command?.sourceInfo?.path));

    const extensions = [], seen = new Set();
    for (const descriptor of state.extensions?.values() ?? []) {
      const name = text(descriptor?.name);
      if (!name) continue;
      seen.add(name);
      // Committed proof (an actual tool/command from that source) precedes the
      // session marker, which only fires later in native startup. The descriptor
      // source is canonical by contract; canonicalizing is a cache hit and keeps
      // a file URL or a plain path matching the same registration file.
      const committed = observed.has(sourcePath(descriptor.source));
      const started = sessionId !== null && descriptor.sessionId === sessionId;
      extensions.push({ name, version: descriptor.version ?? null, active: committed || started ? true : null,
        instrumented: true });
    }
    for (const name of [...discovered.keys()].sort()) {
      if (seen.has(name)) continue;
      const manifest = discovered.get(name);
      extensions.push({ name, version: manifest.version, active: true, instrumented: false });
    }
    return { extensions, tools: rows, availability, coverage: COVERAGE };
  };

  const measure = fn => {
    const counters = sampling(), begun = performance.now();
    try {
      const value = fn(), took = performance.now() - begun;
      counters.n += 1; counters.totalMs += took;
      counters.maxMs = counters.maxMs === null ? took : Math.max(counters.maxMs, took);
      return value;
    } catch (error) {
      const took = performance.now() - begun;
      counters.n += 1; counters.failed += 1; counters.totalMs += took;
      counters.maxMs = counters.maxMs === null ? took : Math.max(counters.maxMs, took);
      throw error;
    }
  };

  // Used for the run-start header; its wall cost is one inventory sample.
  const inventory = ctx => measure(() => build(ctx));

  // One sample covers the build, the selected-data comparison and the write.
  const emitInventory = ctx => measure(() => {
    const data = build(ctx), encoded = JSON.stringify(data);
    const writer = trace?.currentWriter?.() ?? null; // no writer means tracing is not active
    if (encoded !== state.lastInventory && writer && typeof writer.point === 'function') {
      writer.point('pi.inventory', data, writer.root);
      state.lastInventory = encoded;
    }
    state.toolInventory = new Map(data.tools.map(tool => [tool.name, tool]));
    return data;
  });

  return { sourcePath, inventory, emitInventory };
}
