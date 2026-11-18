// Process-local trace measurements. Counts/usage are observations, never budgets.
import { performance } from 'node:perf_hooks';

export const usageFields = {
  inputTokens: u => u?.input, outputTokens: u => u?.output,
  cacheReadTokens: u => u?.cacheRead, cacheWriteTokens: u => u?.cacheWrite,
  cacheWrite1hTokens: u => u?.cacheWrite1h, reasoningTokens: u => u?.reasoning,
  totalTokens: u => u?.totalTokens, costInput: u => u?.cost?.input,
  costOutput: u => u?.cost?.output, costCacheRead: u => u?.cost?.cacheRead,
  costCacheWrite: u => u?.cost?.cacheWrite, costTotal: u => u?.cost?.total,
};
export const finite = n => typeof n === 'number' && Number.isFinite(n);
export function newUsage() {
  return Object.fromEntries(Object.keys(usageFields).map(k => [k, { reported: 0, missing: 0, knownSubtotal: 0 }]));
}
export function addUsage(target, usage) {
  addUsageFacts(target, Object.fromEntries(Object.entries(usageFields).map(([key, get]) => [key, get(usage)])));
}
export function addUsageFacts(target, facts) {
  for (const key of Object.keys(usageFields)) {
    const value = facts?.[key], field = target[key];
    if (finite(value)) { field.reported++; field.knownSubtotal += value; }
    else field.missing++;
  }
}
export function usageView(target) {
  return { ...Object.fromEntries(Object.entries(target).map(([k, f]) => [k,
    f.reported && !f.missing ? f.knownSubtotal : null])), observations: structuredClone(target) };
}
export function newSummary() {
  return { turnCount: 0, turnSpanEndCount: 0, modelRequestCount: 0, modelSpanEndCount: 0, assistantMessageCount: 0, auxiliaryMessageCount: 0, loopCount: 0,
    toolCount: 0, nestedToolCount: 0, unjoinedProviderRequestCount: 0, unjoinedProviderResponseCount: 0, orphanedStreamEventCount: 0, tools: new Map(), usage: newUsage(), totalUsage: newUsage(),
    auxiliaryUsage: newUsage(), toolReportedUsage: newUsage() };
}
export function summaryView(s) {
  return { turnCount: s.turnCount, turnSpanEndCount: s.turnSpanEndCount,
    modelRequestCount: s.modelRequestCount, modelSpanEndCount: s.modelSpanEndCount,
    assistantMessageCount: s.assistantMessageCount, auxiliaryMessageCount: s.auxiliaryMessageCount, loopCount: s.loopCount,
    toolCount: s.toolCount, nestedToolCount: s.nestedToolCount, unjoinedProviderRequestCount: s.unjoinedProviderRequestCount,
    unjoinedProviderResponseCount: s.unjoinedProviderResponseCount, orphanedStreamEventCount: s.orphanedStreamEventCount,
    toolsByName: Object.fromEntries([...s.tools].map(([name, f]) => [name, {
      ...f, tookMsTotal: f.completed === f.calls && !f.tookMsMissing ? f.tookMsTotal : null,
      tookMsKnownTotal: f.tookMsTotal, unfinished: f.calls - f.completed,
      nativeDurationMsTotal: f.nativeDurationMissing || f.completed !== f.calls ? null : f.nativeDurationKnownMs,
    }])), usage: usageView(s.totalUsage), assistantUsage: usageView(s.usage), auxiliaryUsage: usageView(s.auxiliaryUsage),
    toolReportedUsage: usageView(s.toolReportedUsage),
    usageScope: 'Own observed assistant + nonduplicated compaction usage; any unjoined provider hook makes totals unknown while retaining known subtotals. Assistant/auxiliary breakdowns and potentially descendant-inclusive tool reports are separate. Tool reports are never added; hidden client calls remain unobserved.',
    durationScope: 'Tool residence/native execute sums by name may overlap; never add them as elapsed wall time.' };
}
// Failure-only shutdown view: no estimates for work whose native end was not
// observed. Starts/unfinished counts are separate from ended-work totals.
export function endedSummaryView(s) {
  const full = summaryView(s);
  return { turnCount: s.turnSpanEndCount, modelSpanCount: s.modelSpanEndCount,
    assistantMessageCount: s.assistantMessageCount, auxiliaryMessageCount: s.auxiliaryMessageCount,
    toolCount: [...s.tools.values()].reduce((n, f) => n + f.completed, 0),
    toolsByName: Object.fromEntries([...s.tools].filter(([, f]) => f.completed > 0).map(([name, f]) => [name, {
      completed: f.completed, errors: f.errors,
      tookMsTotal: f.tookMsMissing ? null : f.tookMsTotal,
      nativeDurationMsTotal: f.nativeDurationMissing ? null : f.nativeDurationKnownMs,
    }])), usage: full.usage, assistantUsage: full.assistantUsage, auxiliaryUsage: full.auxiliaryUsage,
    toolReportedUsage: full.toolReportedUsage,
    scope: 'Partial snapshot of ended work only, not final totals. Observed starts/unended work are separate; no duration/usage estimate for active spans. Usage is reported Native Pi data, not provider billing.' };
}
export function toolStarted(s, name, nested) {
  s.toolCount++; if (nested) s.nestedToolCount++;
  if (!s.tools.has(name)) s.tools.set(name, { calls: 0, completed: 0, errors: 0,
    tookMsTotal: 0, tookMsMissing: 0, nativeDurationKnownMs: 0, nativeDurationMissing: 0 });
  s.tools.get(name).calls++;
}
export function toolEnded(s, name, wall, native, error) {
  const f = s.tools.get(name); if (!f) return;
  f.completed++; if (error) f.errors++;
  if (finite(wall)) f.tookMsTotal += wall; else f.tookMsMissing++;
  if (finite(native)) f.nativeDurationKnownMs += native; else f.nativeDurationMissing++;
}
export function distribution(values) {
  if (!values.length) return { unit: 'ms', n: 0, p50: null, p95: null, max: null, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  // Requested p50/p95: nearest-rank percentile definition, not thresholds/caps.
  return { unit: 'ms', n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1),
    total: sorted.reduce((a, b) => a + b, 0) };
}

// Node process.resourceUsage()/libuv: these RUSAGE fields are unimplemented,
// returned as 0 by Node, not evidence of zero activity. Node API docs, v24:
// https://nodejs.org/api/process.html#processresourceusage
const unsupported = ['sharedMemorySize', 'unsharedDataSize', 'unsharedStackSize',
  'swappedOut', 'ipcSent', 'ipcReceived', 'signalsCount'];
const counterFields = ['minorPageFault', 'majorPageFault', 'fsRead', 'fsWrite',
  'voluntaryContextSwitches', 'involuntaryContextSwitches'];
export function sampleResources(sampling) {
  const begun = performance.now();
  try {
    const sample = { at: performance.now(), cpu: process.cpuUsage(),
      resource: process.resourceUsage(), memory: process.memoryUsage() };
    sample.samplingWallMs = performance.now() - begun;
    if (sampling) { sampling.n++; sampling.totalMs += sample.samplingWallMs; sampling.maxMs = Math.max(sampling.maxMs ?? 0, sample.samplingWallMs); }
    return sample;
  } catch {
    if (sampling) { const took = performance.now() - begun; sampling.n++; sampling.failed++; sampling.totalMs += took; sampling.maxMs = Math.max(sampling.maxMs ?? 0, took); }
    return null;
  }
}
export function resourceView(before, after) {
  if (!after) return { available: false, reason: 'Node resource sampling unavailable' };
  const delta = (a, b) => finite(a) && finite(b) ? a - b : null;
  return { available: true,
    cpu: { unit: 'us', user: before ? delta(after.cpu.user, before.cpu.user) : after.cpu.user,
      system: before ? delta(after.cpu.system, before.cpu.system) : after.cpu.system,
      scope: before ? 'This process during span residence, not exclusive attribution; overlapping scopes must not be added.' : 'This process lifetime total (RUSAGE_SELF), not descendants.' },
    samplingWallMs: { start: before?.samplingWallMs ?? null, end: after.samplingWallMs },
    resourceUsage: { userCPUTime: before ? delta(after.resource.userCPUTime, before.resource.userCPUTime) : after.resource.userCPUTime,
      systemCPUTime: before ? delta(after.resource.systemCPUTime, before.resource.systemCPUTime) : after.resource.systemCPUTime,
      cpuTimeUnit: 'us', maxRSS: after.resource.maxRSS, maxRSSUnit: 'KiB',
      maxRSSScope: 'Process-lifetime high-water at observation, not an interval allocation or additive delta.',
      ...Object.fromEntries(counterFields.map(k => [k, before ? delta(after.resource[k], before.resource[k]) : after.resource[k]])),
      ...Object.fromEntries(unsupported.map(k => [k, null])),
      counterScope: before ? 'Residence deltas; fsRead/fsWrite are filesystem block I/O operations, other counters are counts.' : 'Process lifetime counters; fsRead/fsWrite are filesystem block I/O operations.',
      unavailableFields: unsupported },
    memoryUsage: { unit: 'bytes', ...after.memory },
    childCpu: { user: null, system: null, unit: 'us', available: false,
      reason: 'Pi tool events expose no child PID/wait4 rusage; Node process.resourceUsage is RUSAGE_SELF. Subagent Pi processes report their own totals in their own runs.' } };
}

export function truncationFacts(result) {
  const unknown = { truncated: null, originalBytes: null, originalLines: null,
    outputBytes: null, outputLines: null, truncatedBy: null, fullOutputPathPresent: false };
  try {
    const details = result?.details, structured = result?.structuredContent;
    const t = details?.truncation;
    const boolean = v => typeof v === 'boolean' ? v : null;
    const number = v => finite(v) ? v : null;
    return { truncated: boolean(t?.truncated) ?? boolean(details?.truncated),
      structuredTruncated: boolean(structured?.truncated),
      originalBytes: number(t?.totalBytes) ?? number(details?.totalBytes), originalLines: number(t?.totalLines) ?? number(details?.totalLines),
      outputBytes: number(t?.outputBytes), outputLines: number(t?.outputLines),
      truncatedBy: ['bytes', 'lines'].includes(t?.truncatedBy) ? t.truncatedBy : null,
      firstLineExceedsLimit: boolean(t?.firstLineExceedsLimit), lastLinePartial: boolean(t?.lastLinePartial),
      appliedMaxBytes: number(t?.maxBytes), appliedMaxLines: number(t?.maxLines),
      matchLimitReached: number(details?.matchLimitReached), linesTruncated: boolean(details?.linesTruncated),
      resultLimitReached: number(details?.resultLimitReached), entryLimitReached: number(details?.entryLimitReached),
      fullOutputPathPresent: typeof details?.fullOutputPath === 'string' || typeof structured?.full_output_path === 'string',
      exitCode: number(structured?.exit_code), toolReportedWallSeconds: number(structured?.wall_time_seconds),
      exitCodeScope: details?.monitor && details?.backgroundClass ? 'Monitor launch receipt, not command completion' : 'Returned tool result; not an inferred child CPU/command status',
      metadataScope: 'truncated is model-facing metadata; structuredTruncated is a separate structured-output cap (native bash differs). Absent flags stay unknown. Full-output path value and all content excluded.' };
  } catch { return unknown; }
}
