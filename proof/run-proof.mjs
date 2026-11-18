// Live-proof driver: drives one headless Pi process over RPC through ordinary
// tool activity, a skill expansion, an optional late-registration probe, and
// /new. Usage: node run-proof.mjs <a|b>  (a = bare, b = extension point).
// Outputs (kept under the proof root): profile/, sessions/, traces/,
// <run>-result.json.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = process.argv[2];
if (run !== 'a' && run !== 'b') {
  console.error('usage: node run-proof.mjs <a|b>');
  process.exit(2);
}
if (!process.env.PROOF_ROOT) throw new Error('set PROOF_ROOT to a fresh external directory');
const outRoot = resolve(process.env.PROOF_ROOT);
mkdirSync(outRoot, { recursive: true });
if (readdirSync(outRoot).length) {
  console.error(`refusing to reuse existing proof root ${outRoot}`);
  process.exit(2);
}
const profile = join(outRoot, 'profile');
const sessions = join(outRoot, 'sessions');
const traces = join(outRoot, 'traces');
const tmp = join(outRoot, 'tmp');
mkdirSync(join(profile, 'extensions', 'subagent'), { recursive: true });
mkdirSync(sessions, { recursive: true });
mkdirSync(traces, { recursive: true });
mkdirSync(tmp, { recursive: true });

// Bare-profile skill for the /skill: expansion path.
mkdirSync(join(profile, 'skills', 'demo'), { recursive: true });
const skillFile = join(profile, 'skills', 'demo', 'SKILL.md');
writeFileSync(skillFile, '---\nname: demo\ndescription: A proof-only skill for the command-path skill read test.\n---\n\n# demo\nA proof-only skill. Read this file to prove the command path.\n');

// Workspace file for the read tool.
const workspaceFile = join(outRoot, 'workspace.txt');
writeFileSync(workspaceFile, 'proof workspace content\n');

const extensions = [join(repo, 'extensions', 'flattrace-pi.js'), join(repo, 'proof', 'fixture-provider.mjs')];
if (run === 'b') extensions.push(join(repo, 'proof', 'second-extension.mjs'));
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  packages: [],
  extensions,
  // Codemode stays callable for the nested-read proof case; direct tools
  // are untouched (+ prefix adds, never replaces the inherited set).
  defaultTools: ['+codemode'],
  retry: { enabled: true },
}));

const piBin = process.env.PI_CLI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
let piRoot = null;
try {
  const cliReal = execFileSync('realpath', [piBin]).toString().trim();
  let dir = dirname(cliReal);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === '@earendil-works/pi-coding-agent') { piRoot = dir; break; }
    } catch { /* keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
} catch { /* fall through */ }
if (!piRoot) {
  console.error('cannot locate the installed pi package root');
  process.exit(2);
}
const cli = piBin;

const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1',
  TMPDIR: tmp, XDG_STATE_HOME: join(outRoot, 'state'),
  PROOF_PI_AI: join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  PROOF_PI_API: join(piRoot, 'dist/index.js'),
  PROOF_WORKSPACE_FILE: workspaceFile,
  PROOF_SKILL_FILE: skillFile,
  PROOF_SECOND_VOCAB: join(repo, 'proof', 'second-ext', 'events.json'),
  PROOF_CONV_VOCAB: join(repo, 'node_modules', 'flattrace', 'schema', 'conventions-events.json'),
  PROOF_LATE_VOCAB: join(repo, 'proof', 'late-events.json'),
  PROOF_CHILD_SCRIPT: join(repo, 'proof', 'child-run.mjs'),
  PROOF_CHILD_VOCAB: join(repo, 'proof', 'child-events.json'),
  PROOF_CANARY_VALUE: `canary-value-${run}-9f3c1e`,
};
for (const key of ['FLATTRACE_TRACEPARENT', 'FLATTRACE_LEVEL', 'FLATTRACE_DIR']) delete env[key];
env.FLATTRACE_DIR = traces;

const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--session-dir', sessions,
  '--model', 'proof-faux/work', '--models', 'proof-faux/work'],
  { cwd: outRoot, env, stdio: ['pipe', 'pipe', 'inherit'] });

const events = [];
let buffer = '';
let idCounter = 0;
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'response' && record.id && pending.has(record.id)) {
      pending.get(record.id)(record);
      pending.delete(record.id);
    } else {
      events.push(record);
      if (settleWaiters.length && record.type === 'agent_settled') {
        const waiters = settleWaiters.splice(0);
        for (const w of waiters) w(record);
      }
    }
  }
});
const settleWaiters = [];
const waitSettled = () => new Promise(resolve => settleWaiters.push(resolve));
const command = obj => new Promise((resolve, reject) => {
  const id = `cmd-${++idCounter}`;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ id, ...obj }) + '\n', error => {
    if (error) { pending.delete(id); reject(error); }
  });
});
const fail = message => { console.error(`FAIL: ${message}`); child.kill('SIGKILL'); process.exit(1); };

const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
child.once('error', error => fail(`spawn: ${error.message}`));

const prompt = async text => {
  const response = await command({ type: 'prompt', message: text });
  if (!response.success) fail(`prompt rejected: ${JSON.stringify(response)}`);
  await waitSettled();
};

await prompt('TOOLS: run ordinary tool activity on the workspace');
await prompt('/skill:demo summarize the skill');
// The skill file changes on disk after the /skill: expansion was persisted.
// The command-path skill read must hash the persisted block body, not these
// new bytes; the earlier tool-path whole read still matches the original.
const skillOrigBytes = readFileSync(skillFile);
writeFileSync(join(tmp, 'skill-orig.md'), skillOrigBytes);
writeFileSync(skillFile, '---\nname: demo\ndescription: A proof-only skill, rewritten after load.\n---\n\n# demo\nRewritten after the expansion was persisted.\n');
if (run === 'b') await prompt('LATE: probe the registration boundary');
const beforeNew = events.filter(e => e.type === 'agent_settled').length;
const newSession = await command({ type: 'new_session' });
if (!newSession.success) fail(`new_session rejected: ${JSON.stringify(newSession)}`);
await prompt('SECOND: confirm the new session works');
child.stdin.end();
const result = await exit;

const traceFiles = readdirSync(traces).filter(f => f.endsWith('.jsonl'));
const sessionFiles = [];
const walk = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) sessionFiles.push(p);
  }
};
walk(sessions);

const summary = { run, exit: result,
  settledBeforeNew: beforeNew, settledTotal: events.filter(e => e.type === 'agent_settled').length,
  traceFiles: traceFiles.map(f => join(traces, f)), sessionFiles,
  skillOrigSha256: createHash('sha256').update(skillOrigBytes).digest('hex'),
  skillOrigBytes: skillOrigBytes.length,
  eventTypes: [...new Set(events.map(e => e.type))].sort() };
writeFileSync(join(outRoot, `${run}-result.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (result.code !== 0) fail(`pi exited ${result.code} ${result.signal ?? ''}`);
