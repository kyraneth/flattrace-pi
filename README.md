# flattrace-pi

A generic [flattrace](https://github.com/kyraneth/flattrace) recorder for Pi sessions.
When enabled, it writes local JSONL traces of timing, causal links, journal pointers and tool activity.

## Install

Requirements: Pi >= 1.4.0 and < 2, Node >= 22.18 (or Pi's higher requirement).
Pi 1.4.0 is the tested floor: the recorder depends on `agent_settled.aborted`,
the `<skill>` block format, `parentToolCallId`, and `appendMessage` object identity.

```bash
pi install npm:flattrace-pi
```

Or add it to the `packages` array in your Pi settings:

```json
{ "packages": ["npm:flattrace-pi"] }
```

For local development, `pi install ./flattrace-pi` loads the package directory.

## Turn recording on or off

Recording is opt-in. Set a writable directory before starting Pi:

```bash
export FLATTRACE_DIR="$HOME/.local/share/flattrace-pi"
export FLATTRACE_LEVEL=1
```

Unset `FLATTRACE_DIR` or set `FLATTRACE_LEVEL=0` to turn recording off.
When off, recording opens no writer, writes no trace files and starts no timer.
A sink failure (unwritable directory, malformed inherited context) disables
tracing for the rest of the process with one stderr warning; product work
is never interrupted.

## Level 1: what it records

One run file per session (`.jsonl` under `$FLATTRACE_DIR`). Envelope `tool`
is the writing program: `flattrace-pi` by default, or the host name given to
`configureHost` (see below). A second session in the same process (`/new`,
`/resume`, `/fork`) opens a new run file whose start carries
`data.links: [{relation: "continues_process", trace, run}]` pointing at the
run it replaces. The old run takes no new spans, drains its open spans, then
ends. At quit, spans still open end `cancelled`. Compaction and model changes
stay in the same run. Process-level samples go to the active run.

Events (see `flattrace-events.json` for the exact field lists):

- `run` — the run span and its end summary: observed counts, usage subtotals
  with known/missing accounting, process residence, sampling costs.
- `pi.agent`, `pi.turn`, `pi.model` (plus `headers`, `response`,
  `first_token`, `unjoined` points), `pi.message`, `pi.tool`
  (plus `unstarted`), `pi.compaction` (plus `unstarted`), `pi.input`,
  `pi.inventory`, `pi.resources`, `pi.ext`.
- `pi.session.bind` — the session id changed (or the first bind). The process
  run outlives any one session; this is the record of which session a span
  belongs to.
- `pi.journal` — exact persisted entry ids. Model, tool and compaction spans
  link the entries Pi persisted for them. The admitted user prompt is joined
  by object identity after `appendMessage`: the message object extensions saw
  at `message_end` is the same object Pi persists, so the join never matches
  text, time, or the latest user row. A steered input that never lands in the
  journal stays unjoined; missing persistence stays missing.
- `pi.skill.read` — a skill file the session actually read, from the two
  observed paths: the persisted `<skill name location>` block of a `/skill:`
  expansion (`source: "command"`), or a `tool_result` whose `input.path` is
  a `SKILL.md` file or a file beside one (`source: "tool"`, including calls
  nested under a parent tool call). Data is
  `{name, path, source, range, bytes, content_sha256, complete}` plus
  `parentToolCallId` for nested calls. The hash covers the bytes actually
  observed — the persisted block body for the command path (never the disk,
  which may have changed since), the exact returned text for the tool path —
  and no content is stored. `range` is `{offset, limit}` for a partial read
  and null for a whole one; `complete` is false when the returned text was
  truncated or partial. It is measured on `tool_result`, never on
  `tool_call`: a failed or blocked read emits no point at all, so no failed
  read can claim a full one.
- `annotate` / `annotation` / `verdict` — detector and grader results (see
  below). A detector notices a shape; a grader compares against a reference.
  Neither is authority: suggestive labels only. These names are declared by
  the flattrace dependency's own `schema/conventions-events.json`, which
  this package registers at load (resolved from the installed `flattrace`
  package) and lists in every run-start `data.vocabularies`; they are
  deliberately not repeated in this package's vocabulary, so composed runs
  never see conflicting definitions.

Deliberately not recorded: the event-loop sampler some setups run stays out
of this package. No message bodies, prompts, tool arguments, results, error
prose, credentials, or file content are stored at the default level.

### What a run records

The vocabulary (`flattrace-events.json`) declares event *shapes*: each event
maps to a kind (`span` or `point`) and its field list. It never validates
payload values. The shared `run` span is exactly the reserved declaration
from the flattrace dependency (`{"kind":"span","fields":{}}`): every
vocabulary in a composed run copies that same block, so a differing `run`
would collide under the union check. The run's data meanings live here, not
in the vocabulary:

- Run start `data`: `command` (`session` for live Pi runs), `sessionId` (the
  Pi session id the run was opened for; turns join to spans on it),
  `level` (the effective `FLATTRACE_LEVEL`), `vocabularies` (the registered
  vocabularies actually in force: `[{tool, version, sha256}]` with the
  SHA-256 over the exact file bytes parsed), `links` (only on a rotated
  run: the `continues_process` pointer at the run it replaces; batch
  detector runs instead link `annotates` at each run they labelled), `env`
  (harness/host facts: `harness.name`, `harness.version`, `host.name`,
  initial `gen_ai.provider.name`, `gen_ai.request.model`,
  `model.requested_effort`, and `session.start_reason` when known; unknown
  stays null), and `inventory` (initial committed-package discovery for
  tools/commands, with the active/instrumented scope caveats). The writer
  itself adds `argv` (empty here), `host`, `version`, and `pid`.
- Run end `data`: `summary` (observed counts, usage subtotals with
  known/missing accounting, wall timings), `process` (this Node process
  residence over the run), `processLifetimeMs` (uptime at close),
  `resourceSampling` / `inventorySampling` (collection costs),
  `cancelledAtQuit` (open spans ended `cancelled` at quit; zero when the run
  drained cleanly), and `outcomeScope` (the run outcome describes local
  session shutdown, not task/model/tool success). A rotated run that drained
  after replacement closes with a drain note instead.
- A check needs the union of the run's vocabularies: pass every file its
  manifest lists with repeatable `--events` (see the flattrace checker).
  An extra `--events` file the manifest does not list fails the check and is
  named; a listed file whose bytes differ fails too. With no manifest (a
  bare-writer run), a single vocabulary file must match the envelope tool.

## Level 2: the opt-in verbosity module

At the default level the recorder stores no argument vectors. Set
`FLATTRACE_LEVEL=2` (or higher) to also load `vocabularies/verbosity.json`
and emit `action` points: one known fact per tool call for Pi's built-in
tools.

- `kind` comes only from a named, versioned allowlist of Pi built-in tools
  (`read`, `edit`, `write`, `bash`, `powershell`, `grep`, `find`, `ls`;
  allowlist version 1.4.0). Anything else records `kind: null`, never a
  guess.
- `argv` passes the writer's `sanitizeArgv` plus tool-specific redaction:
  only scalar path-like parameters are kept; free-text parameters
  (`command`, `content`, `text`, `prompt`, `message` and the like) are never
  stored, and their names are listed in `withheldParams` so the omission is
  explicit.

The vocabulary file declares `action` with `level: 2`, and the run start
lists only the vocabularies actually registered, so a level-1 run never
claims level-2 events.

## Privacy

At level 1 the recorder stores no prompts, message bodies or free-text tool
parameters. Credentials must never be recorded at any level. Counts, timings,
hashes and presence flags are the default; `action.argv` exists only at level 2
and is sanitized before storage. Seeded credential negatives are tested.
Skill reads hash the observed bytes without storing content.

Custom event data and detector labels are supplied by your code: do not put
credentials or private prose in them. Use `flattrace export` to prepare traces
for sharing, and review the exported data before sharing it.

## Extend it with your own vocabulary

At extension load time — before the writer opens on `session_start` — call:

```js
const registry = globalThis.__flattrace_pi;
registry.registerVocabulary("/path/to/your/package/your-events.json");
registry.registerDetector({ name: "my-shape", version: "1.0.0", kind: "code", run });
registry.registerGrader({ name: "my-grade", version: "1.0.0", kind: "code", run });
```

- `registerVocabulary(path)`: registers a package-owned vocabulary file.
  The exact file bytes are hashed (SHA-256) and the pair is listed in the
  run start's `data.vocabularies: [{tool, version, sha256}]`, where tool and
  version come from the nearest `package.json` above the file. A fragment
  that redefines `run` or any `pi.*` event with a different definition is
  refused. Registration after the writer has opened throws an API error; it
  is never silently omitted and never rewrites the flushed start line.
  Points for your events go through `registry.emitPoint(event, data, span?)`,
  which refuses names outside the registered union as described below.
### Write spans from your extension

The process handle also carries the public span/context API (frozen names):

```js
const registry = globalThis.__flattrace_pi;
// At load, before the writer opens: name the run envelope for your program.
// Default is flattrace-pi with the package version. One host per process:
// repeating the same host is a no-op (extension factories re-run on every
// session rotation, with the previous run still open), and any change —
// a different host, or a first host after the writer opened — is an error.
registry.configureHost({ tool: 'my-program', toolVersion: '1.2.0' });

// Async: ends with the outcome the callback reports (a string return, or
// {outcome, data}), `unknown` when it reports none, `error` on throw.
await registry.withSpan('my.event', { where: 'work' }, async span => {
  registry.emitPoint('my.note', { where: 'inside' });
  const traceparent = registry.currentTraceparent(); // W3C string for children
  return 'ok';
});

// Manual: beginSpan returns an opaque handle (null when tracing is off);
// endSpan routes the end to the run that opened the span, even across
// rotation, and never throws for lifecycle reasons.
const handle = registry.beginSpan('my.event', { where: 'work' });
registry.endSpan(handle, 'ok');
const current = registry.currentSpan(); // innermost live span handle, or null
const run = registry.currentRun(); // {trace, run}, or null when tracing is off
```

Spans and points use `AsyncLocalStorage` context. Declare event names in
your vocabulary first. Runtime vocabulary mistakes are fail-safe by default:

- Recording off (`FLATTRACE_DIR` unset or empty, level 0, or writer disabled):
  `beginSpan`, `withSpan`, `emitPoint` and `annotate*` perform no vocabulary
  checks. They return null, or run the `withSpan` callback with a null handle
  and pass its value or throw through unchanged, as for other off-state calls.
- Recording on, undeclared name: `beginSpan` and `emitPoint` return null;
  `withSpan` runs its callback with a null handle, passing its value or throw
  through unchanged. No span or point for that name is written. Instead,
  `pi.trace.undeclared` records `data: {event, api}` once per (event, api) per
  run, where `api` is `beginSpan`, `withSpan` or `emitPoint`.
- Set `FLATTRACE_PI_STRICT=1` in consumer test suites to restore the existing
  undeclared-name error, whether recording is on or off. Only the exact value
  `1` enables strict mode; every other value leaves it off.

Non-vocabulary programming errors, including foreign span handles, non-string
outcomes and `configureHost` conflicts, still throw.

Pass
`currentTraceparent()` to a child process through `FLATTRACE_TRACEPARENT`;
a child writer opened with `fromEnv` parents its run to that span. See the
live proof (`proof/`) for a worked example: nested public-API spans, an
inner point, and a spawned child run.

### Per-call context requires opt-in

A tool must opt in through `traceOptIn` or the public bus handshake to get its
own `pi.tool` span as its execution context. Without opt-in, the recorder can
still observe the tool lifecycle, but the tool's `currentTraceparent()` returns
the run root, not its per-call span. This matters when parenting custom spans
or child processes, especially across parallel tool calls.

```js
import { traceOptIn } from 'flattrace-pi';
pi = traceOptIn(pi, { name: 'my-package', version: '1.0.0', source: import.meta.url });
pi.registerTool(toolDefinition); // register through the returned facade
```

See [the context proof](proof/CONTEXT.md) for the recorder-first,
recorder-last, tracing-off and no-recorder cases and the independent bus fixture.

## Detectors and graders

- `registerDetector({name, version, kind, questions?, run})` /
  `registerGrader({...})`: `kind` is `model`, `code`, or `human`. `run`
  receives `{target: {trace, run, span?, entryId?}, input_sha256, chunk}`
  and returns `{labels: [{label, probability|null}]}` (detector) or verdict
  fields `{correct, score, reward, reason}` plus optional `usage`/`cost`
  (grader). Return `{refused: true, reason}` to record a refusal. The
  recorder wraps each call in an `annotate` span through the shared
  `annotate()` helper (lib/annotate.mjs): it writes the span and the
  resulting `annotation`/`verdict` points in the convention shape —
  `target` `{trace, run, span?, entryId?, t_from?, t_to?, seq?}`, a stable
  `id` across re-labels, optional `supersedes` naming the replaced
  annotation, and `detector` `{name, version, kind}` — and ends the span
  `ok`, `refused`, `error`, or `cancelled`. A call still in flight at
  shutdown ends `cancelled`; close never waits for a detector. An
  unavailable model route never blocks recording: there is no dispatch
  without your `run`, and no retry of an unknown send.

### Annotate the active run directly

`annotateCurrent({detector, target, input_sha256, labels | run, usage?, cost?})`
is exported from `flattrace-pi` and available on `globalThis.__flattrace_pi`.
It uses the private active writer and the same `annotate()` implementation,
without dispatching any registered detector or grader.

```js
import { annotateCurrent } from 'flattrace-pi';
const call = annotateCurrent({
  detector: { name: 'my-shape', version: '1.0.0', kind: 'code' },
  target: { entryId }, input_sha256,
  labels: [{ label: 'shaped', probability: null }],
});
if (call) await call.done;
```

Missing `target.trace` and `target.run` are filled from the active run; an
explicit foreign trace or run throws an API error before writing or running
code. Omit `target` to label the run itself. Supply either a `labels` array or
one `run` callback with the same contract as `annotate`, never both. Optional
`usage` and `cost` are defaults; callback results can override them. The return
is `{span, id, done}`, or null with no trace I/O and no callback execution when
tracing is off or no run is active. This call never opens a writer.

### Batch and late detector runs

A batch or late detector run (for example a learning pass over earlier,
closed runs) is its own run, written through the public `flattrace` Writer
by the program that runs it — flattrace-pi never opens batch runs. That
run links each target run with run-start
`data.links: [{relation: "annotates", trace, run}]`, lists the
conventions vocabulary in `data.vocabularies`, and labels targets through
the same helper the live dispatch uses:

```js
import { Writer } from 'flattrace';
import { annotate } from 'flattrace-pi';

const writer = Writer.fromEnv('my-detector-run', '1.0.0', { argv: [],
  data: { command: 'batch',
    links: [{ relation: 'annotates', trace, run }],
    vocabularies: [{ tool: 'flattrace-conventions', version: '0.3.0', sha256 }] } });
const { id, done } = annotate(writer,
  { detector: { name: 'my-shape', version: '1.0.0', kind: 'code' },
    target: { trace, run, entryId }, input_sha256, chunk: { entryId },
    run: ({ target, input_sha256, chunk }) =>
      ({ labels: [{ label: 'shaped', probability: null }] }) });
await done; // {status: 'ok'|'refused'|'error'|'cancelled', span, id}
writer.close('ok', {});
```

`annotate(writer, {detector, target, input_sha256, chunk, run})` accepts
any flattrace Writer, opens the span synchronously (so a live dispatcher
can track it for at-quit cancellation), and settles asynchronously.
`input_sha256` fingerprints the detector input and is null only with
explicit coverage; `chunk` is passed to `run` and never stored. The live
proof (`proof/`) pairs a live annotation with a batch run targeting a
prior closed proof run; both pass the union checker.

## Check a trace

Use the flattrace 0.3.0 checker with every vocabulary listed in the run's
manifest. For a default level-1 run:

```bash
flattrace check run-*.jsonl --events node_modules/flattrace-pi/flattrace-events.json \
  --events node_modules/flattrace/schema/conventions-events.json
```

Use the paths from your actual installation. Add
`--events node_modules/flattrace-pi/vocabularies/verbosity.json` for level 2
and each custom vocabulary declared by the run. Manifest hashes must match
these exact files.

## Layout

- `extensions/flattrace-pi.js` — Pi extension entry (factory).
- `lib/` — recorder implementation (ESM).
- `flattrace-events.json` — the package vocabulary (owner: this package).
- `vocabularies/verbosity.json` — opt-in level-2 fragment.
- `internal/` — private development notes, excluded from any public export.
- `tests/` — unit tests (`node --test 'tests/*.test.mjs'`).

## Changelog

See `CHANGELOG.md`. License: MIT.
