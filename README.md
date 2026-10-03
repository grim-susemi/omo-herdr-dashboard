# omo-herdr-todo

Concurrent native **Todo**, **DAG** and **worker** surfaces for OmO inside Herdr.
This repository is the public source/package/test foundation (plan task 2 scope):
Node >= 24, ESM, version 0.1.0, MIT. Dashboard behavior is added by later tasks;
nothing here claims a live or installed feature.

## Commands

```
npm test                                      # unit tests (no SDK required)
npm run build                                 # syntax + package contract + public-safety validation
npm run test:host -- --senpi-root <senpi-sdk> # real native-host integration tests
```

`--senpi-root` must point at an installed `@code-yeongyu/senpi` package (for
example a global npm/bun install directory). The harness imports the real SDK
modules read-only, asserts the recorded source identity from
`config/native-source-manifest.json`, and then exercises the actual native
boundaries. There is **no fallback** to an ambient or public runtime: a missing,
non-SDK or version-mismatched root fails the command with an explicit error.

## What `npm run test:host` proves

- `DefaultResourceLoader.loadFinalExtensionSet` yields the stock builtin Todo
  extension first and the test probe extension afterwards (builtin-first order,
  never a manually reordered loader).
- The registered native Todo **tool** callback and the registered native Todo
  **command** callback commit real session entries and real branch state.
- Historical vs current branch reads, malformed input rejection and read-only view
  output.
- The D0-derived **child-session guard**: a populated `senpi-task/children`
  selected session cannot install, capture, publish or mask anything.
- **Capture/restore**: the shared `ctx.ui.setWidget` surface is observed only at
  the exact `todo-sidebar` key; restoration uses the captured native factory
  through the original setter; removal restores the original setter identity and
  leaves exactly one native widget behind.
- Native source hashes are identical before and after the run.

It never changes stock code, prototypes, configuration or the live installation,
and it makes **zero model/provider calls**.

## Private-data policy

The shipped package files contain no machine-local absolute paths, no session or
task identifiers, no auth/config profiles, no evidence logs and no copied native
runtime, model payload or private log content. `npm run build` enforces this with
an explicit scan of exactly the shipped files (`src/`, `scripts/`, `config/`,
`package.json`, `README.md`, `THIRD-PARTY-NOTICES.md`, `LICENSE`) and fails on
violation.

That scan is scoped to the shipped package files, not to every file that may
later become public: the unit and host tests are not shipped and are excluded
from it. The hostile example values in `test/unit/public-safety.test.mjs` are
synthetic placeholders chosen only to trigger the scanner rules; they must never
be a real session, task or machine identity. A preflight scan of the whole
future Git-public source tree is not implemented here and belongs to a later,
separately authorized task.

## Provenance

MIT, see `LICENSE`. Reused third-party elements and their origin commits are
listed in `THIRD-PARTY-NOTICES.md`. The senpi SDK is imported read-only and is not
redistributed here.

## Status

Source/test/build foundation only. Packaging, installation, live QA and public
publication are later, separately authorized tasks.
