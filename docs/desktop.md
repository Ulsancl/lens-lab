# Windows 앱

대상은 Windows 11 x64입니다. `npm run package:desktop`은 `release/windows/Lens-Lab-Setup-<버전>.exe`와 `.sha256`을 생성합니다. 파일 이름의 버전은 package.json을 따릅니다. 배포된 설치 파일과 해시는 [최신 릴리스](https://github.com/Ulsancl/lens-lab/releases/latest)에서 확인할 수 있습니다.

앱 이름은 Lens Lab, ID는 `com.lenslab.app`, 로컬 화면 주소는 `app://lens/`입니다. 사용자 프로필은 Windows 앱 데이터 폴더의 Lens Lab입니다. 도움말의 저장 폴더 열기에서 접근합니다. 창 크기·위치는 프로필에 보관하고 작업 영역 밖으로 나간 창은 사용 가능한 화면 안으로 복원합니다.

파일 메뉴는 새 실험·열기·저장입니다. 실험 메뉴의 **광선 표시 전환**은 광학 조건을 유지한 채 광선 표시만 바꿉니다. 보기의 3D 크게 보기, 도움말의 사용 안내와 프로그램 정보를 사용할 수 있습니다. Ctrl+N/O/S는 새 실험/열기/저장, Ctrl+Shift+R은 광선 표시, Ctrl+Shift+F는 큰 화면, F1은 도움말입니다. 파일 대화상자나 자료 처리 도중 창을 닫으면 종료 확인을 표시합니다.

기본 CI 산출물과 개발용 설치 파일은 미서명이며 Windows의 게시자·평판 경고가 표시될 수 있습니다. SHA-256은 받은 파일의 무결성 확인에 사용합니다. 기본 브랜치의 새 CI 산출물은 `gh attestation verify <설치파일> --repo Ulsancl/lens-lab --source-ref refs/heads/codex/consumer-release --signer-workflow Ulsancl/lens-lab/.github/workflows/ci.yml`로 출처를 확인할 수 있습니다. 자동 업데이트는 없습니다. 기존 실험을 파일로 보관하고 앱을 닫은 뒤 새 설치 파일을 실행합니다. 설치 앱 실행에는 Node.js나 개발 서버가 필요하지 않습니다. 제거 설정은 사용자 앱 데이터를 자동 삭제하지 않도록 구성했습니다.

정식 Windows 서명 빌드는 신뢰된 코드 서명 인증서와 타임스탬프 서비스, 해당 인증서로 서명할 수 있는 안전한 환경이 필요합니다. 해당 환경에서 electron-builder의 Authenticode 서명 방식을 설정하고 `LENS_REQUIRE_SIGNED_INSTALLER=1`, `LENS_SIGNER_THUMBPRINT=<게시자 인증서 지문>`으로 패키징합니다. 설치 파일과 앱 실행 파일 모두에 대해 신뢰할 수 있는 타임스탬프와 인증서 지문을 검사한 다음 체크섬을 생성합니다.

개발 빌드와 `node scripts/desktop.mjs package-test`로 만든 검사 전용 앱은 `LENS_LAB_DATA_DIR`로 링크가 없는 로컬 절대 경로를 지정할 수 있습니다. 검사 전용 앱 경로를 `LENS_DESKTOP_EXE`로 지정해 네이티브 통합 검사를 실행합니다. 일반 설치 앱은 표준 로컬 프로필을 사용합니다. 실제 화면을 사용하는 검사는 한 번에 하나만 실행합니다.
