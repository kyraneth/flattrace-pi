// The publication selection is tracked files minus internal/, not the npm tarball.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDir } from './harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const invoke = (name, cwd = root) => spawnSync(join(root, 'scripts', name),
  ['--root', cwd], { cwd, encoding: 'utf8' });

test('export manifest excludes internal and public tree passes', () => {
  const manifest = invoke('export-manifest');
  assert.equal(manifest.status, 0, manifest.stderr);
  const paths = manifest.stdout.trim().split('\n');
  for (const path of ['README.md', 'scripts/check-public-tree', 'proof/CONTEXT.md'])
    assert.ok(paths.includes(path), path);
  assert.ok(!paths.some(p => p.startsWith('internal/')));
  const check = invoke('check-public-tree');
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('public-tree check rejects a planted tracked marker in a temp copy', t => {
  const copy = testDir(t, 'public-tree-');
  const manifest = invoke('export-manifest');
  assert.equal(manifest.status, 0, manifest.stderr);
  for (const path of manifest.stdout.trim().split('\n')) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(root, path), join(copy, path));
  }
  execFileSync('git', ['init', '-q', copy]);
  execFileSync('git', ['-C', copy, 'add', '.']);
  const clean = invoke('check-public-tree', copy);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const marker = 'shared' + 'brain';
  mkdirSync(join(copy, 'internal'));
  writeFileSync(join(copy, 'internal', 'private.md'), marker);
  execFileSync('git', ['-C', copy, 'add', 'internal/private.md']);
  assert.equal(invoke('check-public-tree', copy).status, 0, 'internal bytes excluded');
  writeFileSync(join(copy, 'README.md'), marker);
  const dirty = invoke('check-public-tree', copy);
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
  assert.match(dirty.stdout, /README\.md:/);
  assert.ok(dirty.stdout.includes(marker));
});
