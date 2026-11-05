# W1 설치 승인 게이트와 되돌림

절차만 기록한다. 현재 실사용 설치나 viewer 재시작은 금지한다.

설치 진입점은 build 후 다음 CLI다. `scripts/install.mjs`와
`dist/install.mjs`를 직접 실행하는 것은 설치 호출이 아니므로 금지한다.
task4 격리 시험도 이 CLI와 임시 `--agent-dir`를 사용한다.

```text
node bin/omo-herdr-dashboard.mjs install --agent-dir "C:/Users/USER/.omo-stable-500/home/.omo/agent" --lang <실제 locale> --dry-run
```

1. **G-W1-0:** task4 및 F1~F4 W1 APPROVE를 확인한다. 실행 당시
   agent-dir/current.json/shim/세대 hash와 locale를 읽고 before 백업한다.
   통합 세대는 Todo/DAG/coordination을 함께 싣기 때문에 무관한 runtime
   파일이 byte-identical인지 diff 목록으로 확인한다.
2. **G-W1-1:** 위 dry-run의 다음 세대와 backup을 승인 카드에 제시한다.
   `<실제 locale>`은 baseline에서 읽은 en/ko/zh-cn 값으로 치환한다.
   `plan.backup`은 승인 당시 current.json이 가리키는 세대와 같아야 한다.
   dist/install.mjs 또는 scripts/install.mjs 직접 실행으로 대체하지 않는다.
3. **G-W1-2:** W1만의 후보 해시, 전체 파일 diff, before/after 예상,
   복귀 대상, viewer 재시작 영향을 보여주고 소유자의 명시적 설치 승인을
   받는다. 미응답은 미설치다. W2 승인과 묶지 않는다.
4. 승인 이후 별도 작업에서만 dry-run과 동일한 명령에서 `--dry-run`을
   제거한다. 소유자와 조정한 창에서만 기존 viewer를 재기동한다. loaded
   process path/hash와 새 세대 일치 증거 후 동일 fixture 4종과 두 크기의
   after 캡처 및 top8을 비교한다. 파일 설치 성공만으로 화면 반영 PASS가 아니다.
5. **되돌림:** 별도 W1 복귀 승인 후 보존한 원래 shim과
   `integration/current.json` 두 파일을 함께 replace-write로 복원하고 기존
   세대 파일은 그대로 둔다. installer 재실행으로 이전 번호를 만드는 방식이
   아니다. 조정된 viewer 재기동 뒤 loaded generation/hash, 원래 locale,
   baseline 기능을 확인한다. 미승인 또는 불명확한 이전 파일이면 복귀 명령을
   실행하지 않는다. 실사용 세션과 다른 pane은 강제 종료하지 않는다.
