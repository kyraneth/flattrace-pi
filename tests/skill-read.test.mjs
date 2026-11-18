// Unit contracts for the skill-read observation helper. No writer needed.
// Hashes cover observed bytes only: the persisted block body (command path)
// or the returned text (tool path). The disk is never read for content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSkillBlockText, skillNameForToolPath, returnedText, rangeFromInput,
  truncatedResult, hashText, skillReadData, clearSkillCache } from '../lib/skill-read.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const scratch = t => {
  const root = mkdtempSync(join(tmpdir(), 'skill-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  clearSkillCache();
  return root;
};

test('command block parses the persisted /skill: expansion shape', () => {
  const parsed = parseSkillBlockText('<skill name="review" location="/skills/review/SKILL.md">\nbody here\n</skill>\n\nuser words');
  assert.deepEqual(parsed, { name: 'review', location: '/skills/review/SKILL.md', content: 'body here', userMessage: 'user words' });
  assert.equal(parseSkillBlockText('plain text'), null);
  assert.equal(parseSkillBlockText('<skill name="x">\nno location\n</skill>'), null);
  assert.equal(parseSkillBlockText(null), null);
});

test('tool path: SKILL.md takes its directory name; beside-file takes the dir name', t => {
  const root = scratch(t);
  const skillDir = join(root, 'review');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# review\n');
  writeFileSync(join(skillDir, 'helper.md'), 'helper\n');
  writeFileSync(join(root, 'plain.md'), 'plain\n');
  clearSkillCache();
  assert.deepEqual(skillNameForToolPath(join(skillDir, 'SKILL.md')), { name: 'review', path: join(skillDir, 'SKILL.md') });
  clearSkillCache();
  assert.deepEqual(skillNameForToolPath(join(skillDir, 'helper.md')), { name: 'review', path: join(skillDir, 'helper.md') });
  clearSkillCache();
  assert.equal(skillNameForToolPath(join(root, 'plain.md')), null);
  assert.equal(skillNameForToolPath(null), null);
  assert.equal(skillNameForToolPath(''), null);
});

test('classification needs no content: a missing file beside a skill still classifies', t => {
  const root = scratch(t);
  const skillDir = join(root, 'review');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# review\n');
  clearSkillCache();
  assert.deepEqual(skillNameForToolPath(join(skillDir, 'absent.md')),
    { name: 'review', path: join(skillDir, 'absent.md') });
});

test('returned text prefers the tool string output, else concatenates text blocks', () => {
  assert.equal(returnedText({ structuredContent: 'exact output' }), 'exact output');
  assert.equal(returnedText({ content: [{ type: 'text', text: 'a' }] }), 'a');
  assert.equal(returnedText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }] }), 'a');
  assert.equal(returnedText({ content: [{ type: 'image', data: 'x' }] }), null);
  assert.equal(returnedText({ content: [] }), null);
  assert.equal(returnedText({}), null);
  assert.equal(returnedText(null), null);
});

test('range comes from offset/limit; null for whole reads', () => {
  assert.equal(rangeFromInput({}), null);
  assert.equal(rangeFromInput({ path: 'x' }), null);
  assert.equal(rangeFromInput(null), null);
  assert.deepEqual(rangeFromInput({ offset: 3 }), { offset: 3 });
  assert.deepEqual(rangeFromInput({ limit: 10 }), { limit: 10 });
  assert.deepEqual(rangeFromInput({ offset: 3, limit: 10 }), { offset: 3, limit: 10 });
  assert.equal(rangeFromInput({ offset: 'x', limit: NaN }), null);
});

test('truncation is read from the tool result details', () => {
  assert.equal(truncatedResult(undefined), false);
  assert.equal(truncatedResult({}), false);
  assert.equal(truncatedResult({ truncation: { truncated: true, outputBytes: 1 } }), true);
  assert.equal(truncatedResult({ truncation: { firstLineExceedsLimit: true } }), true);
  assert.equal(truncatedResult({ truncation: { truncated: false } }), false);
});

test('hash covers exact bytes; no content retained', () => {
  const hashed = hashText('# skill\ncontent\n');
  assert.equal(hashed.bytes, Buffer.byteLength('# skill\ncontent\n', 'utf8'));
  assert.equal(hashed.content_sha256, sha('# skill\ncontent\n'));
});

test('command data hashes the block body: whole, complete, no range', () => {
  const data = skillReadData({ name: 'review', path: '/skills/review/SKILL.md',
    source: 'command', text: 'body here' });
  assert.equal(data.name, 'review');
  assert.equal(data.source, 'command');
  assert.equal(data.range, null);
  assert.equal(data.bytes, Buffer.byteLength('body here', 'utf8'));
  assert.equal(data.content_sha256, sha('body here'));
  assert.equal(data.complete, true);
  assert.ok(!('content' in data));
  assert.ok(!('parentToolCallId' in data));
});

test('tool data: whole read complete; partial and truncated reads incomplete with ranges', () => {
  const whole = skillReadData({ name: 'review', path: '/r/SKILL.md', source: 'tool', text: 'data\n' });
  assert.equal(whole.complete, true);
  assert.equal(whole.range, null);
  assert.equal(whole.content_sha256, sha('data\n'));
  const partial = skillReadData({ name: 'review', path: '/r/SKILL.md', source: 'tool',
    text: 'line2\nline3', input: { offset: 2, limit: 2 } });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.range, { offset: 2, limit: 2 });
  assert.equal(partial.content_sha256, sha('line2\nline3'));
  const truncated = skillReadData({ name: 'review', path: '/r/SKILL.md', source: 'tool',
    text: 'data\n', truncated: true });
  assert.equal(truncated.complete, false);
  assert.equal(truncated.range, null);
});

test('nested tool data carries the real enclosing call id', () => {
  const nested = skillReadData({ name: 'review', path: '/r/SKILL.md', source: 'tool',
    text: 'data\n', parentToolCallId: '7/0' });
  assert.equal(nested.parentToolCallId, '7/0');
  assert.ok(!('content' in nested));
});

test('no text means no data: the caller emits no point', () => {
  assert.equal(skillReadData({ name: 'r', path: '/r/SKILL.md', source: 'tool', text: null }), null);
  assert.equal(skillReadData({ name: 'r', path: '/r/SKILL.md', source: 'tool' }), null);
});
