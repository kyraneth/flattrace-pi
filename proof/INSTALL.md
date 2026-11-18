# Packaged install proof

This uses packed recorder bytes, not the repository extension path. It installs
both tarballs with npm into a fresh profile's `npm/` directory, then runs
`pi install <installed-package-directory>` to register the package in settings
`packages`. Only the offline faux provider is loaded as a raw fixture extension.
No production settings are read or changed: `PI_CODING_AGENT_DIR`, `PI_OFFLINE`,
`TMPDIR` and state paths are set for the proof child.

Requires Pi on PATH (or `PI_CLI`), Node, npm, and Python with flattrace 0.3.0.
Until flattrace 0.3.0 is on the registry, supply its accepted tarball explicitly.
The committed dependency remains the exact registry version, never a local path.

```sh
npm pack --pack-destination /path/to/artifacts
FLATTRACE_PYTHON=/path/to/venv/bin/python node proof/install-proof.mjs \
  /path/to/artifacts/flattrace-pi-0.1.0.tgz \
  /path/to/flattrace-0.3.0.tgz /path/to/fresh-proof-root
```

The script runs a headless RPC session with one `prove_install` tool call,
uses `annotateCurrent` on the installed process handle, and requires a successful
`pi.tool` span and a correctly targeted annotation. It then runs
`python -m flattrace check` with the installed declared vocabularies.
`commands.json` retains real command statuses; `rpc.jsonl`, `stderr.txt`,
`result.json`, sessions and traces remain in the proof root.
