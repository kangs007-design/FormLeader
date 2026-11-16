# Pilot version 1

[GitHub 릴리즈 및 소스 ZIP](https://github.com/kangs007-design/FormLeader/releases/tag/v1.0.0-pilot.1)

- 보존일: 2026-11-16 (Asia/Seoul)
- 태그: `v1.0.0-pilot.1`
- 보존 브랜치: `release/pilot-v1`
- 소스 커밋: `45e0b1293e9eaa5419a7c3fcea21d89a6fcad493`
- 구성: Node.js 22 이상 / SQLite / 내장 정적 WEB / TextSense REST 연동
- 검증: 보존 시점 `npm test` 76개 통과

사용자 인증·관리자 승인, 서식/버전, OCR 작업, 결과 검수, 분리·비교, 내보내기, 업무 전송 등 현재 기능을 이 기준점에 보존합니다. 제품판 전환은 `feature/product-web-was-rdb`에서 진행합니다.

실행은 `npm ci` 후 `.env.example`을 참고해 `.env`를 구성하고 `npm start` 또는 `npm run start:mock`을 사용합니다. 실행 중 생성한 데이터와 비밀값은 소스 릴리즈에 포함하지 않습니다. 계정·문서까지 복구하려면 운영 DB와 원본·결과 파일, `.env`, 인증 비밀키를 별도 백업해야 합니다.

소스 ZIP은 Git 태그에서 생성했습니다. ZIP에 `node_modules`, `.env`, 계정 DB, 문서 파일, VPN 설정은 포함하지 않습니다. 이 소스 릴리즈는 폐쇄망용 실행 패키지가 아니며, 제품판 패키징은 [제품판 전환 안내](../../product/README.md)를 따릅니다.
