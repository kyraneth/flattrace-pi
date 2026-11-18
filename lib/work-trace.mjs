// Generic Pi work recorder. No payload/body/args/result/error prose.
import { performance } from 'node:perf_hooks';
import { hostname } from 'node:os';
import { extensionTracing, OPT_IN_CHANNEL } from './extension-trace.mjs';
import { usageFields, finite, newSummary, summaryView, endedSummaryView, addUsage, addUsageFacts, toolStarted, toolEnded,
  sampleResources, resourceView, truncationFacts } from './trace-metrics.mjs';
import { parseSkillBlockText, skillNameForToolPath, returnedText, truncatedResult, skillReadData } from './skill-read.mjs';
import { dispatchForTurn, cancelAnnotateSpans } from './detectors.mjs';
import { emitAction } from './verbosity.mjs';

const outcomeOf = message => message?.stopReason === 'error' ? 'error'
  : message?.stopReason === 'aborted' ? 'cancelled'
  : ['pending', 'deferred'].includes(message?.stopReason) ? 'unknown' : message ? 'ok' : 'unknown';
const nativeOutcome = value => value === 'completed' ? 'ok' : value === 'aborted' ? 'cancelled' : value === 'error' ? 'error' : null;
const modelFacts = (pi, ctx) => ({ provider: ctx.model?.provider ?? null,
  model: ctx.model?.id ?? null, thinkingLevel: pi.getThinkingLevel() ?? null, api: ctx.model?.api ?? null,
  // Observed native catalog facts, not recorder limits or offered knobs.
  contextWindowTokens: ctx.model?.contextWindow ?? null, catalogMaxOutputTokens: ctx.model?.maxTokens ?? null });
const usageFacts = usage => Object.fromEntries(Object.entries(usageFields).map(([key, get]) => {
  const value = get(usage); return [key, finite(value) ? value : null];
}));
const responseFacts = message => ({ provider: message.provider ?? null, model: message.model ?? null,
  api: message.api ?? null, responseModel: message.responseModel ?? null,
  thinkingLevel: message.thinkingLevel ?? null, providerThinkingLevel: message.providerThinkingLevel ?? null,
  stopReason: message.stopReason ?? null, endTurn: message.endTurn ?? null,
  diagnosticCount: message.diagnostics?.length ?? null, nativeTimestampMs: message.timestamp ?? null,
  responseIdPresent: typeof message.responseId === 'string', errorMessagePresent: typeof message.errorMessage === 'string',
  deferredPresent: Boolean(message.deferred), deferredExpiresAtMs: message.deferred?.expiresAt ?? null,
  deferredPollAfterMs: message.deferred?.pollAfterMs ?? null,
  ...usageFacts(message.usage), nativeDurationMs: message.durationMs ?? null,
  errorKind: message.stopReason === 'error' ? 'provider.error' : message.stopReason === 'aborted' ? 'cancelled' : null });
// Test content presence only; never retain/serialize normalized partial bodies.
function firstContentKind(update) {
  const type = update?.type;
  if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(type) && typeof update.delta === 'string' && update.delta.length) return type.split('_')[0];
  if (['text_end', 'thinking_end'].includes(type) && typeof update.content === 'string' && update.content.length) return type.split('_')[0];
  if (!['text_start', 'thinking_start', 'toolcall_start', 'toolcall_end'].includes(type)) return null;
  const part = update.partial?.content?.[update.contentIndex];
  if (part?.type === 'text' && typeof part.text === 'string' && part.text.length) return 'text';
  if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length) return 'thinking';
  if (part?.type === 'toolCall' && typeof part.name === 'string' && part.name.length) return 'toolcall';
  return null;
}
const httpErrorKind = status => status >= 500 ? 'http.server_error' : status >= 400 ? 'http.client_error' : null;
const newState = () => ({ agent: null, turn: null, compact: null, request: null, previousAgentSpanId: null,
  pendingInput: null, pendingUsers: [], inputCount: 0, currentSessionId: null, activeTools: new Map(),
  summary: newSummary(), extensions: new Map(), toolInventory: new Map(), extStats: new Map(),
  lastInventory: null, sampling: { n: 0, failed: 0, totalMs: 0, maxMs: null } });

export function registerWorkTrace(pi, trace) {
  const { currentWriter, traceEnabled, startSpan, endSpan } = trace;
  let state = null;
  const getState = () => state ??= trace.sessionTraceState(newState);
  const currentWorkSpan = () => state?.compact?.span ?? state?.turn?.span ?? state?.agent?.span ?? currentWriter()?.root;
  // A nested call may outlive turn_end. Execution records own their real
  // lifetime; a turn keeps only a view for journal joins. Reused native IDs
  // are disambiguated by causal async context, never by choosing a later turn.
  const findTool = (toolCallId, sessionId = state?.currentSessionId) => {
    const candidates = [...(state?.activeTools.get(toolCallId) ?? [])];
    const context = trace.currentSpan();
    const causal = context === currentWriter()?.root ? [] : candidates.filter(t => t.parentSpan === context);
    if (causal.length === 1) return causal[0];
    const local = candidates.filter(t => t.sessionId === sessionId);
    return local.length === 1 ? local[0] : null;
  };
  const toolSpanFor = id => findTool(id)?.span ?? null;
  const ext = extensionTracing(pi, trace, getState(), toolSpanFor, currentWorkSpan);
  const removeRequest = pi.events?.on?.(OPT_IN_CHANNEL, request => {
    if (!traceEnabled()) return;
    try { ext.accept(request); } catch { /* local dispatchers retain original behavior */ }
  });

  // The admitted user prompt is joined by object identity: extensions see the
  // message at message_end before Pi persists it with appendMessage; the
  // persisted entry holds the same object. Queued here, resolved against the
  // branch on the next observed event. Never matched by text, time, or latest
  // row. A queued input that never lands in the journal stays unjoined.
  const queueUserMessage = message => {
    const s = getState();
    if (!s.pendingUsers.includes(message)) s.pendingUsers.push(message);
  };
  const resolvePendingUsers = ctx => {
    const s = getState();
    if (!s.pendingUsers.length) return;
    let branch = null;
    try { branch = ctx?.sessionManager?.getBranch?.() ?? null; } catch { return; }
    if (!branch) return;
    const remaining = [];
    for (const queued of s.pendingUsers) {
      const entry = branch.find(candidate => candidate?.message === queued);
      if (!entry) { remaining.push(queued); continue; }
      try {
        currentWriter().point('pi.journal', { spanId: s.agent?.span ?? currentWorkSpan() ?? null,
          entryId: entry.id, role: 'user' }, s.agent?.span ?? currentWorkSpan());
      } catch { /* best effort; the entry itself remains the fact */ }
      tryEmitSkillFromCommand(ctx, entry);
    }
    s.pendingUsers = remaining;
  };
  const messageText = message => {
    if (!message || typeof message !== 'object') return null;
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text).join('\n') || null;
    }
    return null;
  };
  const tryEmitSkillFromCommand = (ctx, entry) => {
    const parsed = parseSkillBlockText(messageText(entry?.message));
    if (!parsed || typeof parsed.location !== 'string' || !parsed.location.length) return;
    // Hash the persisted block body itself, never the current disk file:
    // the block is what the session observed, even if the file changed
    // since the expansion was persisted.
    const data = skillReadData({ name: parsed.name, path: parsed.location,
      source: 'command', text: parsed.content });
    if (!data) return;
    try { currentWriter().point('pi.skill.read', data, currentWorkSpan()); } catch { /* best effort */ }
  };
  const tryEmitSkillFromToolResult = event => {
    // Measured on tool_result, never on tool_call: only the returned text
    // (or the failure) tells what was actually acquired. A failed or
    // blocked read emits no point at all: no acquired or complete claim.
    if (event?.isError) return;
    const path = event?.input?.path;
    const match = skillNameForToolPath(path);
    if (!match) return;
    const text = returnedText(event);
    if (text === null) return;
    const data = skillReadData({ name: match.name, path: match.path, source: 'tool', text,
      input: event?.input ?? null, truncated: truncatedResult(event?.details),
      parentToolCallId: event.parentToolCallId ?? null });
    if (!data) return;
    // The execution span for this call is still open at tool_result, so a
    // top-level read joins its own span; a nested call carries its real
    // enclosing call id in the data and joins its own span first, the
    // enclosing span next. Calls never observed starting fall back to the
    // current work span.
    const self = findTool(event.toolCallId);
    const owner = event.parentToolCallId ? findTool(event.parentToolCallId) : null;
    try { currentWriter().point('pi.skill.read', data,
      self?.span ?? owner?.span ?? currentWorkSpan()); } catch { /* best effort */ }
  };

  const on = (api, name, fn) => api.on(name, (event, ctx) => {
    if (!traceEnabled() || !currentWriter()) return;
    try {
      const s = getState(); s.currentSessionId = ctx.sessionManager.getSessionId();
      fn(event, ctx, s);
      // Resolve after the handler so a join opened by this same event (e.g.
      // the agent span on before_agent_start) is the join target.
      resolvePendingUsers(ctx);
    } catch { /* telemetry cannot interrupt product work */ }
  });

  const early = (name, fn) => on(pi, name, fn);
  const session = ctx => ({ sessionId: ctx.sessionManager.getSessionId() });
  const eachSummary = fn => { fn(state.summary); if (state.agent) fn(state.agent.summary); };
  const resources = () => sampleResources(state.sampling);
  const owner = () => state.compact ?? state.turn;
  const finishRequest = (outcome, data = {}) => {
    const r = state.request; if (!r) return;
    if (r.unjoined) {
      currentWriter().point('pi.model.unjoined', { hookRequestIndex: r.hookRequestIndex,
        phase: 'observation_boundary', boundary: data.observationBoundary ?? (data.superseded ? 'next_request' : 'normalized_boundary'),
        providerDurationMs: null, observedResponseCount: r.responses,
        providerStreamEventCount: r.streamEvents, completionObserved: false }, r.span);
      state.request = null; return;
    }
    const errorKind = data.errorKind ?? (outcome === 'error' ? httpErrorKind(r.httpStatus) ?? 'provider.error' : null);
    const tookMs = endSpan(r.span, outcome, { httpStatus: r.httpStatus, firstDeltaMs: r.firstDeltaMs,
      firstDeltaKind: r.firstDeltaKind, firstTokenMs: r.firstTokenMs, firstTokenKind: r.firstTokenKind,
      hookRequestIndex: r.hookRequestIndex,
      correlation: 'Current observed request; native hooks expose no request ID.',
      normalizedEventCounts: r.normalizedEventCounts, observedResponseCount: r.responses,
      exposedHttpAttemptCount: r.responses,
      observedFailedResponses: r.failedResponses, providerAttemptCount: null, providerRetryCount: null,
      requestHeadersObserved: r.requestHeadersObserved, requestHeaderCount: r.requestHeaderCount,
      providerStreamEventCount: r.streamEvents, streamProvider: r.streamProvider,
      streamApi: r.streamApi, streamModel: r.streamModel,
      retryCoverage: 'Exposed request/response hooks only; transport-hidden attempts/retries are unavailable.',
      ...data, errorKind }, errorKind && outcome === 'error'
        ? { name: errorKind, message: 'Provider/HTTP error; error prose deliberately excluded.' } : undefined);
    if (finite(tookMs)) eachSummary(s => s.modelSpanEndCount++);
    state.request = null;
  };
  const beginRequest = (ctx, startSource, payload = null) => {
    // RFC 9110 §15 HTTP classes; a superseding hook is not an asserted retry.
    finishRequest(state.request?.httpStatus >= 400 ? 'error' : 'unknown', { superseded: true });
    const parent = owner(), hookRequestIndex = state.summary.modelRequestCount;
    const requestData = { ...session(ctx), ...modelFacts(pi, ctx), hookRequestIndex, startSource,
      requestIndex: parent ? parent.requests++ : null,
      // Narrow scalar/count allowlist; never copy or stringify the payload.
      payloadModel: typeof payload?.model === 'string' ? payload.model : null,
      requestMessageCount: Array.isArray(payload?.messages) ? payload.messages.length : null,
      requestToolCount: Array.isArray(payload?.tools) ? payload.tools.length : null,
      requestedMaxTokens: payload?.max_tokens ?? payload?.max_output_tokens ?? payload?.max_completion_tokens ?? null,
      payloadReasoningEffort: typeof payload?.reasoning_effort === 'string' ? payload.reasoning_effort
        : typeof payload?.reasoning?.effort === 'string' ? payload.reasoning.effort : null,
      payloadThinkingType: ['adaptive', 'enabled', 'disabled'].includes(payload?.thinking?.type) ? payload.thinking.type : null,
      payloadThinkingBudgetTokens: finite(payload?.thinking?.budget_tokens) ? payload.thinking.budget_tokens : null,
      streaming: typeof payload?.stream === 'boolean' ? payload.stream : null };
    if (!finite(requestData.requestedMaxTokens)) requestData.requestedMaxTokens = null;
    const span = parent ? startSpan('pi.model', requestData, parent.span) : currentWriter().root;
    if (!parent) currentWriter().point('pi.model.unjoined', { ...requestData, phase: 'request', completionObserved: false,
      reason: 'Provider hook without native turn/compaction; no completion hook or journal join, so no invented model span.' }, span);
    state.request = { span, hookRequestIndex, unjoined: !parent, normalizedEventCounts: {}, begun: performance.now(), httpStatus: null, firstDeltaMs: null,
      firstDeltaKind: null, firstTokenMs: null, firstTokenKind: null, responses: 0, failedResponses: 0, requestHeadersObserved: false,
      requestHeaderCount: null, streamEvents: 0, streamProvider: null, streamApi: null, streamModel: null };
    parent?.models.push(span);
    eachSummary(s => { s.modelRequestCount++; if (!parent) { s.unjoinedProviderRequestCount++; addUsage(s.totalUsage, undefined); } });
  };
  const beginActivity = (event, ctx, startSource) => {
    if (state.agent) return;
    state.currentSessionId = ctx.sessionManager.getSessionId();
    const now = performance.now();
    const input = event.messageType === 'custom' ? null : state.pendingInput;
    state.pendingInput = null;
    const prompted = input?.at ?? now;
    if (state.firstPromptAt === null) state.firstPromptAt = now;
    state.agent = { span: startSpan('pi.agent', { ...session(ctx), previousAgentSpanId: state.previousAgentSpanId,
      startSource, messageType: event.messageType ?? null, inputIndex: input?.index ?? null,
      inputToAgentStartMs: input ? now - input.at : null,
      inputCorrelation: input ? 'Nearest observed idle input; Pi exposes no admitted input ID.' : 'No input hook; admitted-run boundary fallback.' }, currentWriter().root),
      begun: now, prompted, resources: input?.resources ?? resources(), summary: newSummary(), outcome: 'unknown' };
  };

  // The extension entry calls
  // attach() for the hook set below; sessionStarted runs on session_start.
  const sessionStarted = (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const reason = event?.reason ?? null;
    const s = getState();
    const previousSid = s.currentSessionId;
    const rotated = trace.currentWriter() && previousSid !== null && previousSid !== sid;
    if (rotated) {
      // New session: new run file linked to the one it replaces. Recorder
      // state restarts; the old evaluation lineage is dead.
      state = trace.sessionTraceState(newState, true);
      trace.rotateTrace({ sessionId: sid, previousSessionId: previousSid,
        harnessVersion: harnessVersion(), node: hostName(),
        provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null,
        requestedEffort: pi.getThinkingLevel() ?? null, inventory: ext.inventory(ctx), reason });
      getState().currentSessionId = sid;
    } else {
      getState().currentSessionId = sid;
      if (!trace.currentWriter()) {
        trace.ensureTrace({ sessionId: sid, harnessVersion: harnessVersion(), node: hostName(),
          provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null,
          requestedEffort: pi.getThinkingLevel() ?? null, inventory: ext.inventory(ctx), reason });
        try {
          currentWriter().point('pi.session.bind', { sessionId: sid, previousSessionId: null,
            reason, runLinked: false }, currentWriter().root);
        } catch { /* best effort */ }
      }
    }
    try { trace.recordTraceIds(pi, ctx); } catch { /* journal fact only */ }
    try { ext.emitInventory(ctx); } catch { /* best effort */ }
    try { ext.flush(currentWriter().root, { partial: true, boundary: 'session_start' }); } catch { /* fail open */ }
  };

  const harnessVersion = () => harnessVersionFromArgv();
  const hostName = () => {
    try { return hostname(); }
    catch { return null; }
  };

  const attach = api => {
    // session_start opens (or rotates) the writer, so it cannot go through
    // the guarded wrapper that requires an open writer.
    api.on('session_start', (event, ctx) => {
      if (!traceEnabled()) return;
      try {
        sessionStarted(event, ctx);
        resolvePendingUsers(ctx);
      } catch { /* tracing must not break session start */ }
    });
    on(api, 'input', (event, _ctx, s) => {
      const at = performance.now(), index = s.inputCount++;
      if (!s.agent) s.pendingInput = { at, index, resources: resources() };
      currentWriter().point('pi.input', { inputIndex: index, source: event.source ?? null,
        imageCount: Array.isArray(event.images) ? event.images.length : null,
        streamingBehavior: event.streamingBehavior ?? null, duringActivity: Boolean(s.agent) }, currentWriter().root);
      // Observe input without opening work for a prompt another input handler
      // may consume. Only an admitted native run starts pi.agent. No prompt is
      // retained. No body, prompt identity, image data, or wall-clock-derived
      // duration retained.
    });
    on(api, 'before_agent_start', (event, ctx) => { beginActivity(event, ctx, 'before_agent_start'); ext.emitInventory(ctx); });
    on(api, 'agent_start', (event, ctx, s) => {
      beginActivity(event, ctx, 'agent_start'); eachSummary(a => a.loopCount++);
      currentWriter().point('pi.agent.loop', { phase: 'start', loopIndex: s.agent.summary.loopCount - 1 }, s.agent.span);
    });
    on(api, 'turn_start', (event, ctx, s) => {
      s.turn = { span: startSpan('pi.turn', { ...session(ctx), ...modelFacts(pi, ctx), turnIndex: event.turnIndex,
        agentLoopIndex: s.agent ? s.agent.summary.loopCount - 1 : null, nativeTimestampMs: event.timestamp ?? null }, s.agent?.span ?? currentWriter().root),
        begun: performance.now(), resources: resources(), tools: new Map(), models: [], requests: 0 };
      eachSummary(a => a.turnCount++); ext.emitInventory(ctx);
    });
    on(api, 'before_provider_request', (event, ctx) => beginRequest(ctx, 'before_provider_request', event.payload));
    on(api, 'before_provider_headers', event => {
      const r = state.request;
      if (!r) { currentWriter().point('pi.model.headers', { orphaned: true, sinceRequestMs: null, headerCount: Object.keys(event.headers).length }, currentWriter().root); return; }
      r.requestHeadersObserved = true; r.requestHeaderCount = Object.keys(event.headers).length;
      currentWriter().point('pi.model.headers', { sinceRequestMs: performance.now() - r.begun,
        headerCount: r.requestHeaderCount, hookRequestIndex: r.hookRequestIndex, unjoined: r.unjoined }, r.span);
    });
    on(api, 'after_provider_response', event => {
      const r = state.request;
      if (!r) {
        currentWriter().point('pi.model.response', { httpStatus: event.status, errorKind: httpErrorKind(event.status),
          orphaned: true, sinceRequestMs: null }, currentWriter().root);
        eachSummary(s => { s.unjoinedProviderResponseCount++; addUsage(s.totalUsage, undefined); }); return;
      }
      r.httpStatus = event.status; r.responses++;
      const errorKind = httpErrorKind(event.status); if (errorKind) r.failedResponses++;
      // Retry-After syntax/units: RFC 9110 §10.2.3. A server hint, not a retry or a budget.
      const retryAfter = event.headers?.['retry-after'] ?? event.headers?.['Retry-After'];
      currentWriter().point('pi.model.response', { httpStatus: event.status, errorKind,
        hookRequestIndex: r.hookRequestIndex, unjoined: r.unjoined,
        observedResponseIndex: r.responses - 1, sinceRequestMs: performance.now() - r.begun,
        responseHeaderCount: Object.keys(event.headers ?? {}).length,
        retryAfterSeconds: typeof retryAfter === 'string' && /^[0-9]+$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter)) ? Number(retryAfter) : null,
        retryAfterHttpDatePresent: typeof retryAfter === 'string' && !/^[0-9]+$/.test(retryAfter)
          && Number.isFinite(Date.parse(retryAfter)) }, r.span);
    });
    on(api, 'provider_stream_event', event => {
      const r = state.request;
      if (!r) { eachSummary(s => s.orphanedStreamEventCount++); return; }
      r.streamEvents++; r.streamProvider = event.provider; r.streamApi = event.api; r.streamModel = event.model;
      // Raw stream event data is never inspected or emitted, even at higher levels.
    });
    on(api, 'message_start', (event, ctx) => {
      if (event.message?.role === 'user') queueUserMessage(event.message);
      if (event.message.role === 'assistant' && (!state.request || state.request.unjoined)) beginRequest(ctx, 'message_start');
      currentWriter().point('pi.message', { phase: 'start', role: event.message.role,
        nativeTimestampMs: event.message.timestamp ?? null, toolCallId: event.message.role === 'toolResult' ? event.message.toolCallId : null },
      event.message.role === 'assistant' ? state.request?.span ?? currentWorkSpan() : currentWorkSpan());
    });
    on(api, 'message_end', event => {
      if (event.message?.role === 'user') queueUserMessage(event.message);
      currentWriter().point('pi.message', { phase: 'end', role: event.message.role,
        nativeTimestampMs: event.message.timestamp ?? null, toolCallId: event.message.role === 'toolResult' ? event.message.toolCallId : null },
      event.message.role === 'assistant' ? state.request?.span ?? currentWorkSpan() : currentWorkSpan());
      if (event.message.role !== 'assistant') return;
      eachSummary(s => { if (state.compact) { s.auxiliaryMessageCount++; addUsage(s.auxiliaryUsage, event.message.usage); }
        else { s.assistantMessageCount++; addUsage(s.usage, event.message.usage); }
        addUsage(s.totalUsage, event.message.usage); });
      if (state.compact) state.compact.reportedMessages++;
      finishRequest(outcomeOf(event.message), responseFacts(event.message));
    });
    on(api, 'message_update', event => {
      const r = state.request; if (!r) return;
      const update = event.assistantMessageEvent;
      const knownTypes = ['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done', 'error'];
      const type = knownTypes.includes(update?.type) ? update.type : 'unknown';
      r.normalizedEventCounts[type] = (r.normalizedEventCounts[type] ?? 0) + 1;
      if (r.firstDeltaMs !== null && r.firstTokenMs !== null) return;
      const kind = firstContentKind(update);
      const elapsed = performance.now() - r.begun;
      if (r.firstDeltaMs === null && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update?.type)
        && typeof update.delta === 'string' && update.delta.length) {
        r.firstDeltaMs = elapsed; r.firstDeltaKind = update.type;
      }
      if (r.firstTokenMs !== null || !kind) return;
      r.firstTokenMs = elapsed; r.firstTokenKind = update.type;
      currentWriter().point('pi.model.first_token', { sinceRequestMs: elapsed, eventKind: update.type,
        contentKind: kind, contentIndex: update.contentIndex ?? null,
        measurement: 'First nonempty normalized message_update content (start/delta/end); TTFT proxy, not server token production. Headers alone never qualify.' }, r.span);
    });
    on(api, 'tool_call', event => {
      // Authorize-time observation only; never mutates the input. Skill
      // reads are measured on tool_result, never here: only the returned
      // text (or the failure) tells what was actually acquired.
      try { emitAction(event); } catch { /* verbosity must not break tools */ }
    });
    on(api, 'tool_execution_start', (event, ctx, s) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const parentTool = findTool(event.parentToolCallId, sessionId);
      const owningTurn = parentTool?.turn ?? (event.parentToolCallId ? null : s.turn);
      const parent = parentTool?.span ?? (event.parentToolCallId ? currentWriter().root
        : s.turn?.span ?? s.agent?.span ?? currentWriter().root);
      const inventory = s.toolInventory.get(event.toolName);
      const span = startSpan('pi.tool', { ...session(ctx), toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId ?? null, toolName: event.toolName,
        parentSpanUnavailable: Boolean(event.parentToolCallId && !parentTool),
        turnSpanId: owningTurn?.span ?? null,
        extension: inventory?.extension ?? null, extensionVersion: inventory?.extensionVersion ?? null,
        exposure: inventory?.exposure ?? null }, parent);
      const summaries = parentTool?.summaries ?? [s.summary, ...(s.agent ? [s.agent.summary] : [])];
      const tool = { span, sessionId, parentSpan: parent, turn: owningTurn, summaries,
        toolCallId: event.toolCallId, toolName: event.toolName, begun: performance.now(),
        resources: resources(), firstUpdateMs: null, updateCount: 0,
        parentToolCallId: event.parentToolCallId ?? null, ended: false, reportedUsage: null,
        entryId: parentTool?.entryId ?? null };
      owningTurn?.tools.set(event.toolCallId, tool);
      const calls = s.activeTools.get(event.toolCallId) ?? new Set(); calls.add(tool); s.activeTools.set(event.toolCallId, calls);
      if (tool.entryId) currentWriter().point('pi.journal', { spanId: span, entryId: tool.entryId,
        assistantEntryId: owningTurn?.entryId, toolCallId: event.toolCallId,
        parentToolCallId: tool.parentToolCallId }, span);
      for (const summary of summaries) toolStarted(summary, event.toolName, Boolean(event.parentToolCallId));
    });
    on(api, 'tool_execution_update', event => {
      const tool = findTool(event.toolCallId); if (!tool) return;
      tool.updateCount++; tool.firstUpdateMs ??= performance.now() - tool.begun;
    });
    on(api, 'tool_result', event => {
      const tool = findTool(event.toolCallId);
      if (tool) tool.reportedUsage = usageFacts(event.usage);
      // Final end may include later tool_result transformations; aggregate there.
      tryEmitSkillFromToolResult(event);
    });
    // turn_end is a native boundary event: it carries the persisted assistant
    // and tool-result entry ids resolved by Pi itself. Detectors dispatch
    // before the turn span ends; the handler is sync and never blocks the turn.
    on(api, 'turn_end', (event, ctx, s) => {
      if (!s.turn) return;
      try {
        dispatchForTurn({ entryId: event.messageEntryId ?? null, turnSpanId: s.turn.span ?? null,
          getEntry: id => { try { return ctx.sessionManager.getEntry(id); } catch { return null; } } });
      } catch { /* detector dispatch never breaks the turn */ }
      closeTurn(event, ctx, s);
    });
    on(api, 'agent_end', event => {
      const message = event.messages.findLast(m => m.role === 'assistant');
      finishRequest(outcomeOf(message));
      if (state.agent) {
        state.agent.outcome = outcomeOf(message);
        currentWriter().point('pi.agent.loop', { phase: 'end', loopIndex: state.agent.summary.loopCount - 1,
          outcome: state.agent.outcome, messageCount: event.messages.length }, state.agent.span);
      }
      // pi.agent closes at the real settled boundary, not this low-level loop end.
      state.turn = null;
    });
    on(api, 'session_before_compact', (event, ctx, s) => {
      s.compact = { span: startSpan('pi.compaction', { ...session(ctx), reason: event.reason,
        willRetry: event.willRetry, tokensBefore: event.preparation?.tokensBefore ?? null,
        isSplitTurn: event.preparation?.isSplitTurn ?? null, firstKeptEntryId: event.preparation?.firstKeptEntryId ?? null,
        branchEntryCount: Array.isArray(event.branchEntries) ? event.branchEntries.length : null }, s.agent?.span ?? currentWriter().root),
        models: [], requests: 0, reportedMessages: 0 };
    });
    on(api, 'before_agent_start', event => {
      const names = value => Array.isArray(value) ? value.filter(n => typeof n === 'string') : null;
      currentWriter().point('pi.agent.options', { selectedTools: names(event.systemPromptOptions?.selectedTools),
        hiddenTools: names(event.systemPromptOptions?.hiddenTools) }, currentWorkSpan());
    });
    on(api, 'resources_discover', (event, ctx) => { ext.emitInventory(ctx);
      currentWriter().point('pi.resources', { reason: event?.reason ?? null }, currentWriter().root); });
    on(api, 'agent_before_settle', event => {
      if (state.agent) {
        state.agent.outcome = nativeOutcome(event.outcome) ?? state.agent.outcome;
        currentWriter().point('pi.agent.settle', { nativeOutcome: event.outcome ?? null,
          continued: event.continue ?? null, draftEntryCount: Array.isArray(event.entries) ? event.entries.length : null }, state.agent.span);
      }
    });
    on(api, 'session_compact', event => closeCompaction(event));
    on(api, 'session_compact_failed', event => failCompaction(event));
    on(api, 'tool_execution_end', (event, ctx) => {
      const tool = findTool(event.toolCallId, ctx.sessionManager.getSessionId());
      if (!tool) {
        currentWriter().point('pi.tool.unstarted', { toolCallId: event.toolCallId,
          parentToolCallId: event.parentToolCallId ?? null, toolName: event.toolName,
          isError: event.isError, nativeDurationMs: event.durationMs ?? null,
          ...truncationFacts(event.result), reason: 'No uniquely identifiable live execution for this native end (missing start, reused ID, or stale session); no fabricated span/duration.' }, currentWorkSpan());
        return;
      }
      const after = resources();
      const reportedUsage = event.result?.usage ? usageFacts(event.result.usage) : tool.reportedUsage ?? usageFacts(undefined);
      if (!tool.parentToolCallId) for (const summary of tool.summaries) addUsageFacts(summary.toolReportedUsage, reportedUsage);
      const tookMs = endSpan(tool.span, event.isError ? 'error' : 'ok', {
        isError: event.isError, errorKind: event.isError ? 'tool.error' : null, nativeDurationMs: event.durationMs ?? null,
        firstUpdateMs: tool.firstUpdateMs, updateCount: tool.updateCount,
        ...truncationFacts(event.result), reportedUsage,
        terminated: typeof event.result?.terminate === 'boolean' ? event.result.terminate : null,
        process: resourceView(tool.resources, after) }, event.isError
          ? { name: 'tool.error', message: 'Tool reported an error; result/error prose deliberately excluded.' } : undefined);
      tool.ended = true;
      for (const summary of tool.summaries) toolEnded(summary, tool.toolName, tookMs, event.durationMs, event.isError);
      const calls = state.activeTools.get(event.toolCallId); calls.delete(tool);
      if (!calls.size) state.activeTools.delete(event.toolCallId);
    });
    on(api, 'agent_settled', event => {
      const a = state.agent; if (!a) return;
      const after = resources(), settled = performance.now();
      const outcome = event.aborted ? 'cancelled' : a.outcome;
      state.lastSettledAt = settled; state.settledCount++; state.activityWallMsTotal += settled - a.prompted;
      endSpan(a.span, outcome, { aborted: event.aborted,
        summary: { ...summaryView(a.summary), promptToSettledMs: settled - a.prompted,
          admittedToSettledMs: settled - a.begun }, process: resourceView(a.resources, after) });
      state.previousAgentSpanId = a.span; state.agent = null; state.turn = null;
      try { ext.flush(currentWriter()?.root, { boundary: 'agent_settled' }); } catch { /* fail open */ }
    });
    on(api, 'session_shutdown', (event, ctx) => {
      if (state.request?.unjoined) finishRequest('unknown', { observationBoundary: 'shutdown' });
      if (event.reason === 'quit') {
        try { ext.flush(currentWriter().root, { partial: false, boundary: 'session_shutdown' }); } catch { /* fail open */ }
        try { cancelAnnotateSpans(); } catch { /* best effort */ }
        const processTotal = resourceView(null, resources());
        const sampling = state.sampling;
        trace.shutdownTrace('ok', { summary: { ...summaryView(state.summary),
            settledActivityCount: state.settledCount, activityWallMsTotal: state.settledCount ? state.activityWallMsTotal : null,
            promptToSettledMs: state.firstPromptAt !== null && state.lastSettledAt !== null
              ? state.lastSettledAt - state.firstPromptAt : null,
            wallScope: 'First observed/admitted prompt to last settled; includes idle between separate activities. Envelope took_ms remains writer lifetime.' },
          process: processTotal, processLifetimeMs: process.uptime() * 1000, resourceSampling: { ...sampling }, inventorySampling: { ...state.inventorySampling },
          outcomeScope: 'Run outcome describes local session shutdown, not task/model/tool success or the future OS exit status.' },
        true);
      } else {
        // A replaced session keeps its writer for rotation at the next
        // session_start; this run takes no new spans meanwhile.
        trace.setAccepting(false);
        try { ext.flush(currentWriter().root, { partial: true, boundary: 'session_shutdown' }); } catch { /* fail open */ }
        trace.clearTraceContext();
      }
      state.agent = state.turn = state.compact = state.request = state.pendingInput = null;
      state.pendingUsers = [];
      state.previousAgentSpanId = null;
      removeRequest?.();
    });
    return api;
  };

  const closeTurn = (event, ctx, s) => {
    if (!s.turn) return;
    finishRequest(outcomeOf(event.message), responseFacts(event.message));
    const writer = currentWriter();
    const link = (spanId, entryId, data = {}) => writer.point('pi.journal', {
      spanId, entryId, assistantEntryId: event.messageEntryId, ...data }, s.turn.span);
    for (const span of s.turn.models) link(span, event.messageEntryId);
    const results = new Map(event.toolResultEntryIds.map(id => [ctx.sessionManager.getEntry(id)?.message?.toolCallId, id]));
    s.turn.entryId = event.messageEntryId;
    for (const [toolCallId, tool] of s.turn.tools) {
      let top = toolCallId;
      while (s.turn.tools.get(top)?.parentToolCallId) top = s.turn.tools.get(top).parentToolCallId;
      const entryId = results.get(top);
      tool.entryId = entryId ?? null;
      if (entryId && tool.span) link(tool.span, entryId, { toolCallId, parentToolCallId: tool.parentToolCallId });
    }
    const tookMs = endSpan(s.turn.span, nativeOutcome(event.outcome) ?? outcomeOf(event.message), { entryId: event.messageEntryId,
      nativeOutcome: event.outcome ?? null, continued: event.continue ?? null,
      draftEntryCount: Array.isArray(event.entries) ? event.entries.length : null,
      toolResultEntryIds: event.toolResultEntryIds, stopReason: event.message.stopReason ?? null,
      process: resourceView(s.turn.resources, resources()) });
    if (finite(tookMs)) eachSummary(s => s.turnSpanEndCount++);
    s.turn = null;
  };
  const closeCompaction = event => {
    if (state.compact) {
      if (state.compact.models.includes(state.request?.span)) finishRequest('ok');
      for (const spanId of state.compact.models) currentWriter().point('pi.journal', {
        spanId, entryId: event.compactionEntry.id }, state.compact.span);
      // Pi compaction usage is auxiliary; never silently mix it with agent
      // assistant usage or count a wrapped assistant response twice.
      if (!state.compact.reportedMessages) eachSummary(s => {
        addUsage(s.auxiliaryUsage, event.compactionEntry.usage); addUsage(s.totalUsage, event.compactionEntry.usage);
      });
      endSpan(state.compact.span, 'ok', { entryId: event.compactionEntry.id, reason: event.reason,
        willRetry: event.willRetry, fromExtension: event.fromExtension,
        tokensBefore: event.compactionEntry.tokensBefore ?? null, firstKeptEntryId: event.compactionEntry.firstKeptEntryId ?? null,
        fromHook: event.compactionEntry.fromHook ?? null, usage: usageFacts(event.compactionEntry.usage) });
    } else {
      currentWriter().point('pi.compaction.unstarted', { phase: 'complete', entryId: event.compactionEntry.id,
        reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension,
        usage: usageFacts(event.compactionEntry.usage), nativeDurationMs: null,
        observation: 'No compaction start observed; no invented duration or closure of an unrelated request.' }, currentWorkSpan());
      eachSummary(s => { addUsage(s.auxiliaryUsage, event.compactionEntry.usage); addUsage(s.totalUsage, event.compactionEntry.usage); });
    }
    state.compact = null;
  };
  const failCompaction = event => {
    if (state.compact) {
      if (state.compact.models.includes(state.request?.span)) finishRequest('error');
      endSpan(state.compact.span, event.aborted ? 'cancelled' : 'error', {
        aborted: event.aborted, reason: event.reason, willRetry: event.willRetry,
        fromExtension: event.fromExtension, errorKind: event.aborted ? 'cancelled' : 'compaction.error' });
    } else currentWriter().point('pi.compaction.unstarted', { phase: 'failed', aborted: event.aborted,
      reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension,
      errorKind: event.aborted ? 'cancelled' : 'compaction.error', nativeDurationMs: null,
      observation: 'Pi can reject preparation before session_before_compact. No start/duration observed; unrelated provider work is untouched.' }, currentWorkSpan());
    state.compact = null;
  };

  // The running harness entry is this process's argv (the Pi cli), not a
  // package copy: walk to the filesystem root (or the harness package
  // boundary). No invented depth cap.
  function harnessVersionFromArgv() {
    try {
      const { readFileSync, realpathSync } = process.getBuiltinModule('fs');
      const { dirname, join } = process.getBuiltinModule('path');
      let dir = dirname(realpathSync(process.argv[1]));
      while (true) {
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          if (manifest.name === '@earendil-works/pi-coding-agent') return manifest.version ?? null;
        } catch { /* keep walking up */ }
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    } catch { return null; }
  }

  return { attach, sessionStarted,
    inventory: ctx => ext.inventory(ctx),
    instrument: (api, name, version, source) => {
      try { return traceEnabled() ? ext.instrument(api, name, version, source) : api; } catch { return api; }
    },
  };
}
