// Deterministic faux provider for the live proof. No network, no credentials.
// Behavior is driven by the last user message text so each proof step is
// reproducible: TOOLS -> read + bash activity, LATE -> the post-open
// registration probe tool, anything else -> a short text reply.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';

export default async function (pi) {
  const { createAssistantMessageEventStream, getModel } = await import(pathToFileURL(process.env.PROOF_PI_AI).href);
  const workspaceFile = process.env.PROOF_WORKSPACE_FILE;
  const skillFile = process.env.PROOF_SKILL_FILE;

  pi.registerTool({ name: 'prove_late', label: 'Late registration probe',
    description: 'Proof-only: attempts a vocabulary registration after the writer opened',
    parameters: Type.Object({}),
    execute() {
      let outcome;
      try {
        globalThis.__flattrace_pi.registerVocabulary(process.env.PROOF_LATE_VOCAB);
        outcome = 'LATE_REGISTRATION_UNEXPECTEDLY_ACCEPTED';
      } catch (error) {
        outcome = `LATE_REGISTRATION_ERROR: ${error?.message ?? error}`;
      }
      return { content: [{ type: 'text', text: outcome }] };
    } });

  pi.registerTool({ name: 'prove_install', label: 'Packaged recorder probe',
    description: 'Proof-only: annotate the current run through the installed package handle',
    parameters: Type.Object({}),
    async execute() {
      const api = globalThis.__flattrace_pi;
      const call = api.annotateCurrent({
        detector: { name: 'install-proof', version: '1.0.0', kind: 'code' },
        target: {}, input_sha256: createHash('sha256').update('installed-package').digest('hex'),
        labels: [{ label: 'package-loaded', probability: null }],
      });
      if (!call || (await call.done).status !== 'ok') throw new Error('packaged annotation failed');
      return { content: [{ type: 'text', text: 'packaged recorder annotated' }] };
    } });

  pi.registerProvider('proof-faux', {
    baseUrl: 'https://unused.invalid', apiKey: 'fixture-not-a-secret', api: 'proof-faux-api',
    models: [{ ...getModel('openai', 'gpt-4.1'), id: 'work', name: 'Proof faux model', api: 'proof-faux-api' }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const messages = context?.messages ?? [];
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find(m => m?.role === 'user');
      const textOf = m => {
        if (!m) return '';
        if (typeof m.text === 'string') return m.text;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
        return '';
      };
      const prompt = textOf(lastUser);
      // A turn that follows tool results always replies with text: this ends
      // the activity instead of re-issuing the same calls forever.
      const afterTools = last && last.role !== 'user';
      const withTools = !afterTools && prompt.includes('TOOLS');
      const withLate = !afterTools && prompt.includes('LATE');
      const withInstall = !afterTools && prompt.includes('INSTALL');
      // Nested codemode read: the script reads the same skill file through
      // the read tool, so the inner call carries parentToolCallId. The
      // codemode tool may be inactive in profiles that do not enable it;
      // then this call fails and the proof records codemode as unavailable.
      const nestedCode = `const text = await tools.read({ path: ${JSON.stringify(skillFile)} });\nreturn typeof text === 'string' ? text.slice(0, 8) : 'non-text';`;
      const missingSkillFile = join(dirname(skillFile), 'absent.md');
      const content = withInstall
        ? [{ type: 'toolCall', id: 'proof-install', name: 'prove_install', arguments: {} }]
        : withTools
        ? [{ type: 'toolCall', id: 'proof-read', name: 'read', arguments: { path: workspaceFile } },
          { type: 'toolCall', id: 'proof-skill-read', name: 'read', arguments: { path: skillFile } },
          { type: 'toolCall', id: 'proof-skill-partial', name: 'read', arguments: { path: skillFile, offset: 2, limit: 2 } },
          { type: 'toolCall', id: 'proof-skill-missing', name: 'read', arguments: { path: missingSkillFile } },
          { type: 'toolCall', id: 'proof-nested', name: 'codemode', arguments: { code: nestedCode } },
          { type: 'toolCall', id: 'proof-bash', name: 'bash', arguments: { command: 'echo $PROOF_CANARY_VALUE' } }]
        : withLate
          ? [{ type: 'toolCall', id: 'proof-late', name: 'prove_late', arguments: {} }]
          : [{ type: 'text', text: 'fixture reply: prompt observed' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        stopReason: (withTools || withLate || withInstall) ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        await options.onPayload?.({ messages: [{ content: 'payload' }] }, model);
        await options.onHeaders?.({ authorization: 'withheld' }, model);
        await options.onResponse?.({ status: 200, headers: {} }, model);
        stream.push({ type: 'start', partial: message });
        stream.push({ type: withTools || withLate || withInstall ? 'toolcall_delta' : 'text_delta', contentIndex: 0,
          delta: 'proof', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
}
