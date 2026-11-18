# Changelog

## 0.1.2

- Depend on flattrace 0.3.1, the fresh release number replacing several
  different builds that carried 0.3.0. Align the dependency-version contract
  test with that pin. Recorder behavior is unchanged.

## 0.1.1

- Make undeclared public event names fail-safe: skip vocabulary checks when
  recording is off; when on, refuse the event and record one
  `pi.trace.undeclared` diagnostic per (event, api) per run. `withSpan` still
  passes its callback's value or throw through without writing a span.
- Add `FLATTRACE_PI_STRICT=1` for consumer tests that need undeclared-name
  errors even when recording is off. Only the exact value `1` enables it.
- Preserve non-vocabulary programming errors.

## 0.1.0

- Support Pi `>=1.4.0 <2`; 1.4.0 is the tested floor for
  `agent_settled.aborted`, `<skill>` blocks, `parentToolCallId` and
  `appendMessage` identity.
- Export `annotateCurrent` from the module and process handle. It uses the
  active private writer, fills target trace/run, refuses foreign runs or
  traces, accepts labels or one callback, never dispatches other detectors,
  and returns null without trace I/O when recording is off.
- Depend on the exact registry version `flattrace@0.3.0`. The registry
  release is a prerequisite for installation from npm; no lockfile is
  included while that dependency is unavailable from the registry.
- Include the per-call context proof and document the required `traceOptIn`
  or bus-handshake opt-in for a tool's own execution context.
- Add a public export manifest and exact-byte privacy scan; exclude
  `internal/` from the public tree and proof/tests/internal from npm.
- Document installation, levels, sharing, extension APIs and trace checking.

## 0.1.0 (preview) — annotation convention + skill-read correction

- Annotations follow the flattrace convention: `target`
  `{trace, run, span?, entryId?, t_from?, t_to?, seq?}`, stable `id`,
  optional `supersedes`, `detector` `{name, version, kind}`. `annotate`,
  `annotation` and `verdict` are no longer declared here; the dependency's
  `schema/conventions-events.json` is registered from the installed
  `flattrace` package and listed in every run-start `data.vocabularies`.
  (`verdict` goes too: the union checker refuses two different definitions
  of one event, so keeping ours alongside the conventions file would fail
  every composed check. Verdict points now use the convention keys.)
- New shared helper `annotate(writer, {detector, target, input_sha256,
  chunk, run})` (also on the process handle and the public surface) works
  with any flattrace Writer — live dispatch and batch/late detector runs
  use the same function. Batch runs are separate runs through the public
  Writer with run-start `data.links: [{relation: "annotates", trace,
  run}]`; flattrace-pi never opens them.
- `pi.skill.read` corrected: measured on `tool_result`, never on
  `tool_call`; the hash covers the returned text (`range` from
  offset/limit, `complete: false` when truncated or partial); failed or
  blocked reads emit no point; the command path hashes the persisted block
  body, never the disk; nested codemode reads carry their real enclosing
  call id.

## 0.1.0 (preview)

First preview of the generic Pi recorder.

- Process-global writer singleton over the published `flattrace` writer;
  same-version second evaluation reuses the writer, a conflicting registry
  refuses to open a second one.
- Generic recorder: agent, turn, model, tool, message, journal, compaction,
  input, inventory, resources, late nested spans, sink-failure behaviour.
  No event-loop sampler, no account-specific events, no argument storage at
  the default level.
- Run per session: `/new`, `/resume`, `/fork` open a linked run file
  (`data.links: [{relation: "continues_process", trace, run}]`); the old run
  drains, then ends; open spans end `cancelled` at quit.
- User-entry join by object identity after `appendMessage`; nearest-idle
  stays only as a labelled heuristic on `pi.agent`.
- `pi.session.bind` and `pi.skill.read` (command block and tool paths,
  including nested calls) with content hashes and no content.
- Extension point: `registerVocabulary`, `registerDetector`,
  `registerGrader` (names frozen by the API test); exact-bytes hashing;
  late registration throws; `pi.*`/`run` redefinition refused.
- Opt-in verbosity module: `action` at `level: 2`, named versioned
  allowlist of built-in tools, sanitized argv, free-text parameters
  withheld by name.
- Detector/grader contract: each call wrapped in an `annotate` span;
  `refused`/`error`/`cancelled` outcomes; close never waits.

Second pass (same 0.1.0 preview artifact, rebuilt):

- The preview used a local flattrace 0.3.0 tarball; the release uses the exact
  registry dependency instead.
- Public span/context API (frozen): `withSpan`, `beginSpan`/`endSpan`,
  `currentSpan`, `currentTraceparent`, `currentRun`; `AsyncLocalStorage`
  context; no-ops when tracing is off; undeclared names refused at the call.
- `configureHost({tool, toolVersion})` at load names the run envelope;
  a first host after open, or any change, is an error, while repeating the
  same host is a no-op (extension factories re-run on session rotation).
  Same-contract detector/grader re-registration is likewise idempotent.
- The `run` declaration is exactly the reserved 0.3.0
  `{"kind":"span","fields":{}}`; run-data meanings moved to the README
  section "What a run records"; a test pins structural equality with the
  dependency's `schema/run-declaration.json` by file hash.
- Live proofs re-run; proof b adds a `configureHost` extension, nested
  public-API spans with an inner point, and a spawned child run parented
  through `currentTraceparent`; every run file passes the 0.3.0 union
  checker (Python + Rust CLI) with repeatable `--events`, plus one
  composed-run negative.
