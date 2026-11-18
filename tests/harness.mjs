// Shared fake-Pi harness for recorder tests. Mirrors the native event shapes
// the recorder consumes; end-to-end acceptance lives in the live proof.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetRegistryCache } from '../lib/registry.mjs';

export function testDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function savedEnv(t) {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  return saved;
}

export function enableTrace(t, trace, dir) {
  savedEnv(t);
  process.env.FLATTRACE_DIR = dir;
  delete process.env.FLATTRACE_TRACEPARENT;
  delete process.env.FLATTRACE_LEVEL;
  trace.resetTrace();
  resetRegistryCache();
  t.after(() => trace.resetTrace());
}

export function harness(apiExtras = {}) {
  const handlers = new Map(), bus = new Map(), appended = [];
  const api = {
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn); handlers.set(name, list);
      return () => { const i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); };
    },
    events: {
      on(channel, fn) {
        const list = bus.get(channel) ?? new Set();
        list.add(fn); bus.set(channel, list);
        return () => list.delete(fn);
      },
      emit(channel, request) { for (const fn of [...(bus.get(channel) ?? [])]) fn(request); },
    },
    getThinkingLevel: () => 'high',
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    appendEntry(type, data) { appended.push({ type, data }); },
    ...apiExtras,
  };
  const branch = [];
  const entries = new Map();
  const ctx = {
    sessionManager: {
      getSessionId: () => ctx.sessionId,
      getEntry: id => entries.get(id),
      getBranch: () => branch,
    },
    model: { provider: 'fixture', id: 'test' },
    sessionId: 'session',
  };
  const emit = async (name, event = {}) => {
    for (const fn of [...(handlers.get(name) ?? [])]) await fn({ type: name, ...event }, ctx);
  };
  return { api, ctx, branch, entries, appended, emit };
}

export const assistantMessage = (overrides = {}) => ({ role: 'assistant',
  content: [{ type: 'text', text: 'RESPONSE_SEEDED_NEGATIVE' }],
  model: 'test', provider: 'fixture', thinkingLevel: 'high', stopReason: 'toolUse',
  usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6 }, ...overrides });

export async function runActivity(h, { sessionId = 'session', tools = [] } = {}) {
  h.ctx.sessionId = sessionId;
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('before_agent_start', { messageType: 'user' });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('message_end', { message: assistantMessage() });
  for (const [toolCallId, parentToolCallId, toolName] of tools) {
    await h.emit('tool_execution_start', { toolCallId, parentToolCallId, toolName });
  }
  for (const [toolCallId, , toolName] of [...tools].reverse()) {
    await h.emit('tool_execution_end', { toolCallId, toolName, isError: false, durationMs: 1, result: {} });
  }
  h.entries.set('assistant-1', { id: 'assistant-1', message: { role: 'assistant' } });
  for (const [toolCallId] of tools) {
    if (!toolCallId.includes('/')) h.entries.set(`r-${toolCallId}`, { id: `r-${toolCallId}`, message: { toolCallId } });
  }
  await h.emit('turn_end', { message: assistantMessage(), messageEntryId: 'assistant-1',
    toolResultEntryIds: [...h.entries.keys()].filter(k => k.startsWith('r-')),
    outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_end', { messages: [assistantMessage()] });
  await h.emit('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
  await h.emit('agent_settled', { aborted: false });
}
