# Per-tool-call context proof

Requires installed Pi 1.4.0 on PATH (or `PI_CLI`), Node, and installed repository dependencies. The faux provider is offline and needs no credentials. Choose a fresh external proof directory; Pi's profile, sessions, traces and TMPDIR stay inside each scenario root.

```sh
export PROOF_ROOT=/path/to/fresh/context-proof
for scenario in recorder-first recorder-last off no-recorder; do
  node proof/context-proof.mjs "$scenario" "$PROOF_ROOT/$scenario"
  node proof/verify-ctx.mjs "$PROOF_ROOT/$scenario"
done
node --test 'tests/*.test.mjs'
```

`verify-ctx.mjs <scenario-root> [alternate-captures.jsonl]` also accepts seeded captures. Copy S1's captures, swap the two `probe_optin` span objects for one negative, and replace one `probe_optin` span with a plain capture's span for another. Both must exit 1 with a call-specific span mismatch. The alternate-captures mode skips only byte-equivalence with native result text, so the trace remains the independent oracle.

The barrier is per tool pair: both executions must enter before either reads context, then each awaits a real event-loop tick. Each capture includes the observed arrival count. Raw plain execution is intentionally not opted in. The bus fixture independently implements the public declaration/activation/arm protocol without importing recorder code.

`currentSpan()` returns an object (`{event, span}`), or null. Do not confuse that with the span-id field of `currentTraceparent()`: plain execution may have a null currentSpan while its traceparent falls back to the run root. The verifier reports the actual ambient traceparent classification.

Check each enabled trace with flattrace 0.3.0 using repeatable `--events` for every vocabulary declared in its run-start `data.vocabularies`; match the vocabulary file's SHA-256 to the declaration. The standard files are `flattrace-events.json` and `node_modules/flattrace/schema/conventions-events.json`. Full observed results belong in the external proof root's `CONTEXT-PROOF.md`, not in source control.
