import { traceOptIn } from '../lib/opt-in.mjs';
import { probe } from './context-probe-tool.mjs';

export default function (pi) {
  const opted = traceOptIn(pi, { name: 'context-optin', version: '1.0.0', source: import.meta.url });
  pi.registerTool(probe('probe_plain'));
  opted.registerTool(probe('probe_optin', () => ({ rawApi: opted === pi })));
}
