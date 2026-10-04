# Isolated candidate installation

Build and inspect a local archive before changing an intended installation. Run build, pack and verification commands from the source checkout. An extracted runtime archive omits development scripts/tests; use its `node bin/omo-herdr-todo.mjs install --agent-dir <disposable-agent-directory>` CLI. These commands use an explicitly chosen disposable agent directory:

```bash
npm run build
npm run test:package
npm pack
node bin/omo-herdr-todo.mjs install --agent-dir <disposable-agent-directory> --lang ko --dry-run
node bin/omo-herdr-todo.mjs install --agent-dir <disposable-agent-directory> --lang ko
```

Todo requires `--agent-dir`. Install the DAG candidate into that same explicit disposable directory. Never rely on the DAG HOME fallback during tests. Separate managed namespaces are `herdr-todo/integration` and `herdr-dag/integration`.

Reinstall promotes a fresh generation and retains the previous generation as a backup. Unmanaged destinations are rejected before writes. Failed promotions restore the original pointer/wrapper and remove staged output; readonly destinations remain readonly. Dry-run prints targets without installation. Locale supports en, ko and zh-cn; updates preserve the saved choice unless changed explicitly.

Installed, loaded and live are different. Copying a generation installs it. ResourceLoader importing its managed entry loads it. A current matching process and painted owner/session/epoch/sequence/token ACK make its role live. Primary activation requires a deliberate new session or `/reload`; isolated QA does not authorize that cutover.

Use README's qa:live command for archive/runtime hashes, actual native calls, frames and cleanup proof. Existing Windows POSIX-helper fixture failures in the DAG full suite are reported separately from current related tests/build/package checks.

한국어: 두 설치 명령에 같은 격리 경로를 지정하세요. 파일 복사, 확장 로드, 실제 화면 준비는 서로 다른 단계입니다.
