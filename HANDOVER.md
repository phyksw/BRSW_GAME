# HANDOVER — BRSW_GAME (멀티게임 라운지)

> 마지막 갱신: 2026-07-26 · 현재 버전 **v0.27** · 작성: Claude Code 세션 인수인계용

## v0.27 (유저 피드백 + UI 리프레시)
- **지뢰**: 본진 금지구역 2→1칸(사용 가능 100→110칸, 부활칸은 보호 유지 — 서버 `M_FORBID`와 클라 `M_BAN`을 **항상 동시에** 수정해야 함), 내 차례 '띠로링' 효과음+진동(오목·알까기도 `turnPing`), 내 색 3중 표시(HUD '나' 알약+내 색 점수 / 보드 내 말 '나' 태그 / 상단 `#myside` 칩).
- **오목 33 금수(쌍삼)**: 기본 ON, 첫 수 전 방 전체 토글(`o33`), 이후 잠금. 서버가 거부(`{t:'nope',why:'33'}`)하고 클라가 **동일 판정을 미러링**해 금수 칸에 빗금(✕)+즉시 거부음. 5목 완성수는 예외. 판정 함수는 서버 `forbidden33`/클라 `oForbid` — **한쪽만 고치면 안 됨**. 회귀 도구: `scratchpad/parity33.js`(두 구현 소스를 추출해 17만 칸 퍼징), `omok33.js`(프로토콜 10케이스).
- **UI**: 캔버스 폰트 33곳이 실제로 Arial로 폴백되던 문제 수정(`"Pretendard Variable"`), input 16px(iOS 확대 버그), 대비 교정, 모드별 accent(`body.m-*` + `--rgb`/`--acc-ink`), 로비 런처 카드, 스피너 오버레이, 플레이어 패널 아바타, 턴 알약, 채팅 버블, 모바일 밀도, 보드 아트(나무/발광 배경, 테트리스 고스트를 조각 색으로), `prefers-reduced-motion`.
- **CSS 전략**: v0.27 블록은 `</style>` 직전에 **덧붙여 덮는다**. 옛 규칙을 지우지 않으므로 특이도를 반드시 확인할 것 — 실제로 `.gitem.on .soon`(0,3,0)이 새 `.gitem .soon`(0,2,0)을 눌러 초록 배경이 남는 버그가 있었다.

## v0.26 (버그 수정 — 유저 제보 2건)
- **게임 중 갑자기 먹통**: 서버 flood guard(10초/40개)가 빠른 플레이의 정상 mmove까지 조용히 드롭 → 최대 10초간 "다운"처럼 보임 (Node WS 하네스로 재현). 한도 160으로 상향(stroke는 320). 지뢰 모드에 시간제한은 없고, 200턴 스톨 가드는 정상적으로 승패 배너와 함께 끝남을 실측 확인.
- **입장 시 오목 1초 깜빡임**: 클라가 state 도착 전 selMode(기본 오목)로 임시 렌더. 수정 — 초대링크에 모드 힌트(`#CODE-mode`, btnCopy·해시 파서·코드 입력란·최초방문자 경로 모두 지원), lastRoom에 모드 저장, 모드 미상 진입은 bootOv("게임 불러오는 중…", 8초 워치독) 표시, selMode 변경 시 로비 하이라이트 동기화, 해시 정규화는 replaceState(BACK 오염 방지, 뒤로가기=나가기 유지).

## 프로젝트 개요
- Cloudflare Workers + Durable Objects 기반 실시간 멀티게임 라운지 (오목·그림 맞추기·알까기·리듬·테트리스·망각의 지뢰, 땅따먹기는 준비중 버튼만 존재)
- 저장소: https://github.com/phyksw/BRSW_GAME (main 직커밋, 커밋마다 vN.NN 버전 태그를 커밋 메시지와 `public/index.html` 헤더 `.tag`에 표기)
- 라이브: https://games.phyksw.workers.dev
- 구조: `src/worker.js`(서버 권위 게임 로직, 방=Durable Object 1개), `public/index.html`(클라이언트 전체 — CSS/JS 단일 파일), `wrangler.toml`

## 최근 작업 내역 (2026-07-16~17 세션)
| 버전 | 커밋 | 내용 |
|---|---|---|
| v0.22 | `5be2f79` | 신규 게임 "망각의 지뢰" (11x11 심리전, 데스게임 원작) — 이전 계정 세션 작업, 푸시만 이번에 |
| v0.23 | `5279e1f` | 지뢰 말 리디자인: 전용 폰(minePiece, 시안/앰버) + 칸별 좌표(a1~k11) + 상태 배지(mnBadge: 👑😵🤝💫✨) |
| v0.24 | `c9dd0d8` | 좌표 라벨 8→12px + 명도 상향 (모바일 판독 불가 피드백) |
| v0.25 | `fe4db96` | 모바일 UX 배치: 💣 글로우 디스크, 보드 핀치줌 허용, 턴 신호 3중화(폰 글로우 링+▼/▲ 마커, 패널 색 펄스, 햅틱), 패널 돌 색을 폰과 매칭(p1c/p2c), HUD 텍스트 확대 |

모두 main에 푸시 완료, Cloudflare 배포 완료 (마지막 배포 Version `542672d0`).

## 개발/테스트 방법
- 로컬: `npx wrangler dev --port 8787` (부모 폴더 `.claude/launch.json`에 "wrangler-dev" 구성). 파일 저장 시 핫리로드.
- 게임 로직 검증: Node 내장 WebSocket 2인 클라이언트로 `ws://127.0.0.1:8787/ws/<ROOM>` 프로토콜 직접 테스트가 가장 확실.
- 캔버스 렌더 검증: 브라우저 콘솔에서 상태 합성 → `mrender()` 직접 호출 → `canvas.toDataURL()`을 로컬 수신 서버로 POST해 PNG 확인. `fillText` 훅으로 fillStyle/alpha/textBaseline 계측 가능.
- 배포: `npx wrangler deploy` (OAuth 토큰 인증 유지 중). 배포 직후 엣지 캐시가 구버전을 수십 초 서빙하므로 `curl '...?cb=...'`로 새 버전 태그 뜰 때까지 확인.

## 코드 함정 (이번 세션에서 실제로 물린 것들)
1. **공유 캔버스 컨텍스트**: 모든 게임 모드가 전역 `cx` 하나를 공유, 모드 전환 시 리셋 없음. `textBaseline`/`globalAlpha`/`shadowBlur`/`setLineDash`를 바꾸면 함수 끝에서 반드시 복원 (mrender는 'alphabetic'으로 종료해야 함).
2. **이모지 fillText는 fillStyle의 alpha를 물려받음**: 반투명 fill 설정 후 이모지를 그리면 거의 안 보임. 이모지 직전에 불투명 fillStyle 명시 (v0.23 배지, v0.25 💣ㆍ두 번 물림).
3. **touchstart preventDefault는 핀치줌을 죽임**: CSS `touch-action`과 무관하게 제스처 전체 거부. 현재 구조 — touchstart는 건드리지 않음 / 스크롤은 touch-action CSS(`@supports(touch-action:pinch-zoom)` 가드) / 한 손가락 touchmove만 preventDefault / 합성 마우스는 touchend 취소 / 롱프레스는 contextmenu 취소.
4. 새 게임 모드 추가 체크리스트는 memory(`brsw-game-dev-workflow.md`) 참조.

## 미확인·후속 항목
- [ ] **실기기 테스트 필요**: 핀치줌(Android Chrome/iOS Safari)과 햅틱 진동은 로직 검증만 됨 — 데스크톱 브라우저에선 재현 불가.
- [ ] 최상단 행 ▲ 마커가 아래 셀 좌표 라벨을 ~5px 가림 (수용한 트레이드오프).
- [ ] 턴 펄스 애니메이션에 `prefers-reduced-motion` 미적용 (접근성 폴리시).
- [ ] 로비 "🗺️ 땅따먹기" 게임 미구현 (준비중 버튼만).
- [ ] 진동은 페이지가 백그라운드면 스펙상 발화 불가 — 백그라운드 턴 알림이 필요하면 Notification API 검토.
- [ ] 재접속 8회 포기 후 자동 재연결 경로 없음 (나가기→재입장만 가능) — online/visibilitychange 리스너나 재시도 버튼 검토.
- [ ] 채팅에 타입별 레이트리밋 없음 (총량 게이트만) — 스팸 억제는 후속.

## 프로세스 노트
- 배포 전 적대적 리뷰(멀티에이전트 워크플로)가 두 번 연속 실제 결함을 잡음 (v0.23 textBaseline 누수, v0.25 핀치줌 데드코드 + 💣 알파 0.30). 렌더/입력 변경은 배포 전 리뷰 권장.
- 이 환경 Browser pane은 `computer{action:"screenshot"}` 타임아웃 → toDataURL POST 방식 사용. 무거운 toDataURL 연속 호출은 탭을 멈출 수 있으니 호출당 1렌더+1전송으로 분할.
