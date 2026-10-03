# Third-party notices

## omo-herdr-dag

- License: MIT
- Origin: https://github.com/jc01rho/omo-herdr-dag
- Origin commit: `bb4388d5d046507605e2cf0e8731d2f0ce2f85b7`
- Origin file: `extension.mjs` (child-session discriminator used inside the
  `session_start` handler)
- Reused here: the selected-child-session discriminator semantics implemented in
  `src/child-guard.mjs` (`senpi-task/children` path segment on the selected
  session file), so that an in-process child agent that inherits a parent pane
  environment never installs the probe, wraps the shared setter, reads a branch or
  masks a native surface.

No runtime code, model payload, private log, session identifier or machine-local
path was copied from the origin repository; only the discriminator behavior with
its retained notice and origin commit.

## @code-yeongyu/senpi

The installed Senpi SDK is imported read-only at test time (dynamic `import()`
from the `--senpi-root` path). It is a runtime dependency of the test command
only and is not bundled, vendored, modified or redistributed by this repository.
