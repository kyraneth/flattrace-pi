// The `run` declaration must stay exactly the reserved one flattrace 0.3.0
// publishes at schema/run-declaration.json. Under the 0.3.0 union check,
// every composed vocabulary declares run, and any definition other than the
// reserved one conflicts with a vocabulary that copies it — so ours must be
// the reserved block, not measurement prose.
//
// Fixture provenance: tests/fixtures/run-declaration.0.3.0.json is the
// byte-exact schema/run-declaration.json from the accepted dependency source
// (sibling build branch feature/0.3.0 @ f3c0474; the accepted npm tarball
// does not ship schema/). The test pins that file by its SHA-256, then
// asserts our shipped `run` is structurally equal to it (object key order
// ignored, array order and descriptions counted — the union-check rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const RESERVED_SHA256 = '38eb5cb40f07e001b6bb63f13a4b87a96ef18500936391c55410ce70d18080a3';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalize(value[k])]));
  }
  return value;
}
const sameDefinition = (a, b) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

test('shipped run declaration is structurally equal to the reserved 0.3.0 declaration', t => {
  const fixtureBytes = readFileSync(new URL('./fixtures/run-declaration.0.3.0.json', import.meta.url));
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), RESERVED_SHA256,
    'the fixture must stay the byte-exact reserved declaration from the accepted 0.3.0 source');
  const reserved = JSON.parse(fixtureBytes.toString('utf8'));
  assert.deepEqual(reserved, { kind: 'span', fields: {} });
  const shipped = JSON.parse(readFileSync(new URL('../flattrace-events.json', import.meta.url), 'utf8'));
  assert.ok(sameDefinition(shipped.events.run, reserved),
    `shipped run must equal the reserved declaration, got ${JSON.stringify(shipped.events.run)}`);
});
