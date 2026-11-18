// One six-call assistant message, then a final reply. Never uses the network.
import { pathToFileURL } from 'node:url';
export default async function (pi) {
  const { createAssistantMessageEventStream, getModel } = await import(pathToFileURL(process.env.PROOF_PI_AI).href);
  pi.registerProvider('proof-context', {
    baseUrl: 'https://unused.invalid', apiKey: 'fixture-not-a-secret', api: 'proof-context-api',
    models: [{ ...getModel('openai', 'gpt-4.1'), id: 'work', name: 'Context fixture', api: 'proof-context-api' }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const tools = context.messages.at(-1)?.role === 'user';
      const content = tools ? ['plain', 'optin', 'bus'].flatMap(kind => [1, 2].map(n => ({
        type: 'toolCall', id: `ctx-${kind}-${n}`, name: `probe_${kind}`, arguments: {},
      }))) : [{ type: 'text', text: 'All probes completed.' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        stopReason: tools ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        await options.onPayload?.({ messages: [] }, model);
        stream.push({ type: 'start', partial: message });
        stream.push({ type: tools ? 'toolcall_delta' : 'text_delta', contentIndex: 0, delta: 'fixture', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
}
