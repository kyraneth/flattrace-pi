// Skill-read observation: the two paths a skill file reaches a session.
//
// (a) command: the persisted `<skill name="..." location="...">` block of a
// /skill: expansion. The hashed bytes are the persisted block body itself,
// never the current disk file: the block proves the expansion, the hash
// proves what the session observed.
// (b) tool: a tool_result whose input.path is a SKILL.md file or a file
// beside one (a skill directory file), including calls nested under a parent
// tool call. The hashed bytes are the exact text the tool returned, never
// the disk. A failed or blocked read emits no point at all: no acquired or
// complete claim.
//
// Both paths store the hash, never the content.
//
// The block shape mirrors Pi's installed agent-session _expandSkillCommand /
// parseSkillBlock: `<skill name="${name}" location="${filePath}">` ...
// `</skill>`.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const SKILL_BLOCK_PATTERN = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** Parse a persisted user message text for the skill expansion block. Null when absent. */
export function parseSkillBlockText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(SKILL_BLOCK_PATTERN);
  if (!match) return null;
  return { name: match[1], location: match[2], content: match[3], userMessage: match[4]?.trim() || undefined };
}

const siblingCache = new Map(); // dir -> boolean (SKILL.md beside it)
function hasSkillBeside(dir) {
  if (!siblingCache.has(dir)) {
    let present = false;
    try { present = existsSync(join(dir, 'SKILL.md')); } catch { present = false; }
    siblingCache.set(dir, present);
  }
  return siblingCache.get(dir);
}
export function clearSkillCache() { siblingCache.clear(); }

/**
 * Decide whether a tool input.path is a skill read. Returns
 * {name, path} or null. A SKILL.md file takes its parent directory name; a
 * file beside a SKILL.md takes that directory name. No content is read here;
 * a missing file still classifies (the read outcome decides the claim).
 */
export function skillNameForToolPath(path) {
  if (typeof path !== 'string' || !path.length) return null;
  const base = basename(path);
  if (base === 'SKILL.md') {
    const dir = dirname(path);
    const name = basename(dir);
    return name ? { name, path } : null;
  }
  const dir = dirname(path);
  if (hasSkillBeside(dir)) {
    const name = basename(dir);
    return name ? { name, path } : null;
  }
  return null;
}

/**
 * The exact text a tool result returned. Prefers the tool's string output
 * (for the read tool this is the full returned text, notices included);
 * otherwise concatenates text content blocks in order. Null when the result
 * carries no text at all (nothing to hash, so the caller emits no point).
 */
export function returnedText(result) {
  if (typeof result?.structuredContent === 'string') return result.structuredContent;
  if (!Array.isArray(result?.content)) return null;
  const parts = result.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text);
  if (!parts.length) return null;
  return parts.join('');
}

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The observed range for a tool input. Null when the whole file was
 * returned (no offset/limit); otherwise the caller-observed {offset, limit}
 * subset that was present. Offset/limit mirror the read tool: 1-indexed
 * line offset, maximum line count.
 */
export function rangeFromInput(input) {
  const offset = finiteNumber(input?.offset);
  const limit = finiteNumber(input?.limit);
  if (offset === null && limit === null) return null;
  return { ...(offset !== null ? { offset } : {}), ...(limit !== null ? { limit } : {}) };
}

/** True when the tool result reports its own truncation of the returned text. */
export function truncatedResult(details) {
  const truncation = details?.truncation;
  if (!truncation || typeof truncation !== 'object') return false;
  return truncation.truncated === true || truncation.firstLineExceedsLimit === true;
}

/** SHA-256 over exact bytes plus the byte count. Content itself is never kept. */
export function hashText(text) {
  const bytes = Buffer.from(text, 'utf8');
  return { bytes: bytes.length, content_sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Full pi.skill.read point data for one observed skill file, or null when
 * there is no text to hash (the caller emits no point). `text` is the exact
 * observed bytes: the persisted block body for the command path, the
 * returned text for the tool path. `complete` is false when the text is a
 * truncated or partial (offset/limit) view; a failed or blocked read never
 * reaches here, so it emits no acquired or complete claim.
 */
export function skillReadData({ name, path, source, text, input = null, truncated = false,
  parentToolCallId = null }) {
  if (typeof text !== 'string') return null;
  const range = source === 'tool' ? rangeFromInput(input) : null;
  const complete = range === null && !truncated;
  const hashed = hashText(text);
  return { name, path, source, range, bytes: hashed.bytes,
    content_sha256: hashed.content_sha256, complete,
    ...(parentToolCallId ? { parentToolCallId } : {}) };
}
