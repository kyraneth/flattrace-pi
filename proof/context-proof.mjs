// Real offline headless Pi; each scenario requires a fresh external proof root.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2];
const scenarios = ['recorder-first', 'recorder-last', 'off', 'no-recorder'];
const rootArg = process.argv[3] ?? process.env.PROOF_ROOT;
if (!scenarios.includes(scenario) || !rootArg) {
  console.error('usage: node proof/context-proof.mjs <recorder-first|recorder-last|off|no-recorder> <proof-root>');
  process.exit(2);
}
const root = resolve(rootArg);
mkdirSync(root, { recursive: true });
if (readdirSync(root).length) throw new Error(`refusing nonempty proof root: ${root}`);
const profile = join(root, 'profile');
for (const dir of ['profile', 'sessions', 'traces', 'tmp']) mkdirSync(join(root, dir));
const cli = process.env.PI_CLI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
let piRoot = dirname(realpathSync(cli));
while (true) {
  try { if (JSON.parse(readFileSync(join(piRoot, 'package.json'))).name === '@earendil-works/pi-coding-agent') break; } catch {}
  const parent = dirname(piRoot);
  if (parent === piRoot) throw new Error('cannot locate Pi package');
  piRoot = parent;
}
const recorder = join(repo, 'extensions/flattrace-pi.js');
const extensions = ['context-provider.mjs', 'context-probes.mjs', 'context-bus.mjs'].map(f => join(repo, 'proof', f));
if (scenario === 'recorder-last') extensions.push(recorder);
else if (scenario !== 'no-recorder') extensions.unshift(recorder);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ packages: [], extensions }));
const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1',
  TMPDIR: join(root, 'tmp'), XDG_STATE_HOME: join(root, 'state'),
  PROOF_PI_AI: join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  PROOF_CAPTURES: join(root, 'captures.jsonl') };
for (const key of ['FLATTRACE_TRACEPARENT', 'FLATTRACE_LEVEL', 'FLATTRACE_DIR']) delete env[key];
if (scenario !== 'off') env.FLATTRACE_DIR = join(root, 'traces');
const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--session-dir', join(root, 'sessions'),
  '--model', 'proof-context/work', '--models', 'proof-context/work'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
const events = [];
let buffer = '', stderr = '';
let settled = false;
child.stderr.on('data', c => { stderr += c; });
child.stdout.on('data', c => {
  buffer += c;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    events.push(event);
    if (event.type === 'agent_settled') { settled = true; child.stdin.end(); }
    if (event.type === 'response' && event.success === false) child.stdin.end();
  }
});
const exit = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
child.stdin.write(JSON.stringify({ id: 'context-proof', type: 'prompt', message: 'Run all six context probes in parallel.' }) + '\n');
const result = { scenario, exit: await exit, settled, piVersion: JSON.parse(readFileSync(join(piRoot, 'package.json'))).version };
writeFileSync(join(root, 'rpc.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
writeFileSync(join(root, 'stderr.txt'), stderr);
writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (stderr) console.error(stderr);
if (result.exit.code !== 0 || !settled) process.exitCode = 1;
