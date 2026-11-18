// Install packed bytes into an isolated Pi profile, then exercise package discovery
// over real offline RPC. No source extension path is used for the recorder.
// Usage: node proof/install-proof.mjs <recorder.tgz> <flattrace.tgz> <fresh-root>
// Set FLATTRACE_PYTHON to the Python executable with the flattrace checker.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [recorderArg, dependencyArg, rootArg] = process.argv.slice(2);
if (!recorderArg || !dependencyArg || !rootArg || !process.env.FLATTRACE_PYTHON) {
  console.error('usage: FLATTRACE_PYTHON=python node proof/install-proof.mjs <recorder.tgz> <flattrace.tgz> <fresh-root>');
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(rootArg);
mkdirSync(root, { recursive: true });
assert.equal(readdirSync(root).length, 0, 'proof root must be fresh');
for (const name of ['profile', 'sessions', 'traces', 'tmp', 'npm-cache']) mkdirSync(join(root, name));
const profile = join(root, 'profile');
const cli = process.env.PI_CLI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
let piRoot = dirname(realpathSync(cli));
while (true) {
  try { if (JSON.parse(readFileSync(join(piRoot, 'package.json'))).name === '@earendil-works/pi-coding-agent') break; } catch {}
  const parent = dirname(piRoot);
  if (parent === piRoot) throw new Error('cannot locate installed Pi package');
  piRoot = parent;
}
const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1',
  TMPDIR: join(root, 'tmp'), XDG_STATE_HOME: join(root, 'state'),
  npm_config_cache: join(root, 'npm-cache'),
  PROOF_PI_AI: join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  PROOF_SKILL_FILE: join(root, 'fixture.md'),
};
for (const name of ['FLATTRACE_DIR', 'FLATTRACE_LEVEL', 'FLATTRACE_TRACEPARENT']) delete env[name];
const commands = [];
function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8' });
  const receipt = { command: [binary, ...args], exit: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr };
  commands.push(receipt);
  writeFileSync(join(root, 'commands.json'), JSON.stringify(commands, null, 2));
  console.log(JSON.stringify(receipt));
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `command failed: ${binary}`);
  return result;
}
const prefix = join(profile, 'npm');
command('npm', ['install', '--prefix', prefix, '--no-save', '--package-lock=false',
  '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
  resolve(recorderArg), resolve(dependencyArg)]);
const installed = join(prefix, 'node_modules', 'flattrace-pi');
command(process.execPath, [cli, 'install', installed]);
const settingsFile = join(profile, 'settings.json');
const settings = JSON.parse(readFileSync(settingsFile));
assert.ok(settings.packages.some(source => typeof source === 'string'
  && resolve(profile, source) === installed), 'Pi install must declare the package');
assert.ok(!settings.extensions?.some(p => p.includes('flattrace-pi')), 'no raw recorder extension');
settings.extensions = [join(repo, 'proof', 'fixture-provider.mjs')];
writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
writeFileSync(join(root, 'fixture.md'), 'Packaged recorder proof.\n');
env.FLATTRACE_DIR = join(root, 'traces');
env.FLATTRACE_LEVEL = '1';
const args = [cli, '--mode', 'rpc', '--session-dir', join(root, 'sessions'),
  '--model', 'proof-faux/work', '--models', 'proof-faux/work'];
const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
const events = [];
let buffer = '', stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    events.push(event);
    if (event.type === 'agent_settled' || (event.type === 'response' && event.success === false)) child.stdin.end();
  }
});
const exit = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
child.stdin.write(JSON.stringify({ id: 'install-proof', type: 'prompt', message: 'INSTALL: exercise the packaged recorder once.' }) + '\n');
const result = await exit;
writeFileSync(join(root, 'rpc.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
writeFileSync(join(root, 'stderr.txt'), stderr);
commands.push({ command: [process.execPath, ...args], ...result });
writeFileSync(join(root, 'commands.json'), JSON.stringify(commands, null, 2));
assert.equal(result.code, 0, stderr);
assert.ok(events.some(e => e.type === 'agent_settled' && e.aborted !== true), 'run must settle');
const calls = events.filter(e => e.type === 'tool_execution_end');
assert.equal(calls.length, 1, 'exactly one tool call');
assert.equal(calls[0].toolName, 'prove_install');
assert.equal(calls[0].isError, false);
const traces = readdirSync(env.FLATTRACE_DIR).filter(p => p.endsWith('.jsonl'));
assert.equal(traces.length, 1, 'one trace file');
const tracePath = join(env.FLATTRACE_DIR, traces[0]);
const rows = readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(rows.some(r => r.event === 'pi.tool' && r.state === 'start'));
assert.ok(rows.some(r => r.event === 'pi.tool' && r.state === 'end' && r.outcome === 'ok'));
const annotation = rows.find(r => r.event === 'annotation');
assert.equal(annotation?.data.label, 'package-loaded');
assert.equal(annotation.data.target.trace, rows[0].trace);
assert.equal(annotation.data.target.run, rows[0].run);
const vocabularies = [join(installed, 'flattrace-events.json'),
  join(prefix, 'node_modules', 'flattrace', 'schema', 'conventions-events.json')];
command(process.env.FLATTRACE_PYTHON, ['-m', 'flattrace', 'check', tracePath,
  ...vocabularies.flatMap(p => ['--events', p])]);
const summary = { installed, packageVersion: JSON.parse(readFileSync(join(installed, 'package.json'))).version,
  piVersion: JSON.parse(readFileSync(join(piRoot, 'package.json'))).version,
  settings: JSON.parse(readFileSync(settingsFile)), exit: result,
  toolCalls: calls.length, tracePath, annotation: annotation.data, vocabularies };
writeFileSync(join(root, 'result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
