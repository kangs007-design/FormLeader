# FormReader 제품판 전환 1단계

현재 단계는 **Nginx / Tomcat / MariaDB 기반의 실행 가능한 전환판**입니다. 전체 OCR 제품의 납품 완료 버전은 아닙니다.

| 구분 | Pilot v1 | 제품판 1단계 |
| --- | --- | --- |
| 소스 기준 | `v1.0.0-pilot.1`, `release/pilot-v1` | `feature/product-web-was-rdb` |
| WEB | Node.js 정적 파일 제공 | Nginx, 기존 HTML/CSS/JS 및 내장 글꼴·PDF.js 재사용 |
| WAS | Node.js | Java 21, Jakarta Servlet 6, Tomcat 10.1, `ROOT.war` |
| RDB | SQLite | MariaDB 11.4, Tomcat JNDI 연결 풀 |
| 계정 | Better Auth + SQLite | Java 인증, 가입 승인·권한·세션·비밀번호 변경을 MariaDB에 저장 |
| 서식 | 등록·수정·이력·복원 | 기존 API와 JSON 구조를 유지, 트랜잭션으로 버전 저장·복원 |
| OCR·검수·내보내기 | 기존 전체 기능 | 후속 이전 대상, API는 `501 MIGRATION_PENDING`으로 응답 |

제품판에는 Node.js 서버를 Tomcat 뒤에 숨겨서 실행하는 구성이 없습니다. 제품 런타임은 Nginx, JVM/Tomcat, MariaDB로 구성합니다. Node.js는 기존 Pilot 실행과 서식 내보내기 작업에서만 사용합니다.

```mermaid
flowchart LR
    Browser[사용자 브라우저] --> WEB[Nginx :8080]
    WEB -->|HTML / CSS / JS / 글꼴 / PDF.js| Assets[로컬 정적 파일]
    WEB -->|/api/*| WAS[Tomcat :8080 / ROOT.war]
    WAS -->|JNDI / JDBC| RDB[(MariaDB :3306)]
    WAS -. 후속 이전 .-> OCR[내부 TextSense OCR]
```

## 빌드 및 실행

빌드 PC에 JDK 21과 Maven이 필요합니다. 최초 빌드는 인터넷 또는 사내 Maven 저장소에서 의존성을 확보합니다.

```powershell
# 저장소 루트에서 실행
./product/scripts/build-offline.ps1
# Maven이 PATH에 없으면 -Maven 'C:/도구/apache-maven/bin/mvn.cmd'
# 캐시만으로 다시 빌드: ./product/scripts/build-offline.ps1 -Offline
```

```sh
sh product/scripts/build-offline.sh
# 캐시만으로 빌드: sh product/scripts/build-offline.sh -o
```

`product/offline`에 WAR, JDBC 드라이버, 화면 파일, 배포 설정, 스키마, SHA256 목록을 모읍니다. 빌드 스크립트는 이미지 다운로드나 서버 실행을 수행하지 않습니다.

인터넷 가능한 준비 PC에서 다음 이미지를 미리 확보합니다. 운영망에서 이미지를 자동으로 받지 않도록 Compose에 `pull_policy: never`를 지정했습니다. 아래 버전은 이번 전환판의 고정 기준이며, 납품 시점의 승인된 보안 패치 버전으로 다시 검증해야 합니다.

```sh
docker pull nginx:1.28.0-alpine
docker pull tomcat:10.1.61-jdk21-temurin
docker pull mariadb:11.4.9
docker image save -o formreader-runtime-images.tar nginx:1.28.0-alpine tomcat:10.1.61-jdk21-temurin mariadb:11.4.9
```

폐쇄망으로 `offline` 폴더와 이미지 TAR를 반입한 뒤:

```sh
docker image load -i formreader-runtime-images.tar
cd offline
sha256sum -c SHA256SUMS
cp .env.example .env
# .env의 초기 설정 토큰·DB 비밀번호·DB 관리자 비밀번호를 각각 다르게 설정
# FORMREADER_PUBLIC_URL을 실제 브라우저 접속 origin과 정확히 일치시킴
docker compose --env-file .env up -d --pull never
```

저장소에서 직접 실행할 때는 `cd product` 후 같은 Compose 명령을 사용합니다. 기본 접속은 `http://localhost:8088`입니다. 최초 `/setup`에서 `.env`에 지정한 **32자 이상의 초기 설정 토큰**으로 관리자를 만듭니다. 토큰은 URL이나 로그에 넣지 않습니다. 최초 설정 후 운영 환경에서 토큰을 제거하거나 교체하고 Tomcat을 재시작할 수 있습니다. 기존 관리자가 있으면 토큰을 알아도 최초 설정을 다시 실행할 수 없습니다.

Docker 사용이 불가능한 납품 환경에서는 동일한 파일을 개별 서버에 배치합니다.

1. Nginx 서버: `web`을 `/opt/formreader/web`에 배치하고 `deploy/nginx.conf`의 upstream `tomcat:8080`을 실제 WAS 주소로 수정합니다. Nginx에 `http_auth_request_module`이 필요합니다.
2. Tomcat 서버: 전용 `CATALINA_BASE`와 비어 있는 `webapps`에 `ROOT.war`를 배포합니다. 배포판에 기본으로 들어 있는 `webapps/ROOT`가 있으면 기본 ROOT가 선택될 수 있으므로 기존 배포는 `appBase` 밖으로 백업합니다. JDK 21, Tomcat 10.1을 사용하고 `lib`의 MariaDB JDBC JAR를 `$CATALINA_HOME/lib`에, `deploy/ROOT.xml`을 `$CATALINA_BASE/conf/Catalina/localhost/ROOT.xml`에 배치합니다.
3. `deploy/server.xml`을 검토·적용하고 Tomcat에 `FORMREADER_PUBLIC_URL`, `FORMREADER_SETUP_TOKEN`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`를 설정합니다. `CATALINA_OPTS`에 `-Dorg.apache.tomcat.util.digester.PROPERTY_SOURCE=org.apache.tomcat.util.digester.EnvironmentPropertySource`를 추가합니다.
4. DB 관리자가 전용 UTF-8 데이터베이스를 생성하고 `db/V001__product.sql`을 **한 번만** 적용합니다. 애플리케이션 계정에는 해당 DB의 `SELECT, INSERT, UPDATE, DELETE` 권한만 부여할 수 있습니다. 기본 MariaDB 이미지의 자동 생성 계정은 해당 DB의 전체 권한을 가지므로 납품 구성에서는 권한을 줄입니다.
5. WEB→WAS 8080, WAS→RDB 3306만 필요한 경로에 허용합니다. `RemoteIpValve`의 신뢰 프록시 주소도 실제 Nginx 주소로 제한합니다. 운영 접속에 HTTPS를 구성하고 `FORMREADER_PUBLIC_URL=https://...`로 설정하면 세션 쿠키에 `Secure`가 적용됩니다. 예시 Nginx 설정은 로컬 검증용 HTTP입니다.

DB는 컨테이너 외부에 포트를 공개하지 않으며 named volume에 보관합니다. 초기 SQL은 **비어 있는 DB 볼륨에서만** 자동 실행됩니다. 이미 사용 중인 볼륨은 관리자가 마이그레이션하며, 재시작으로 스키마가 다시 적용되지는 않습니다. 애플리케이션은 런타임 DDL이나 외부 다운로드를 수행하지 않습니다. DB 백업과 원본·결과 파일 백업은 별개입니다.

## Pilot 보존과 데이터 이전

Pilot 실행: 별도 디렉터리에 `git worktree add ../formreader-pilot-v1 release/pilot-v1` 후 `npm ci` 및 기존 `.env`·데이터 설정으로 실행합니다. 태그에는 계정 DB, 원본 문서, `.env`, VPN 파일이 포함되지 않습니다. 기존 `data`와 `.env`는 원래 위치에 유지되므로 필요하면 별도로 백업해야 합니다. Pilot과 제품판은 데이터 경로와 DB를 공유하지 않습니다.

1단계 이전 도구는 **서식과 서식 버전만** 읽기 전용으로 내보냅니다.

```sh
node product/scripts/export-pilot.script.js data/workspace.sqlite outputs/pilot-templates.sql
# 제품 WAS를 중지하고 빈 제품 DB에 V001 적용 후 실행. --force 옵션 사용 금지.
mariadb --host=DB호스트 --user=관리자 -p 제품DB < outputs/pilot-templates.sql
```

파일 ID·서식 ID·JSON 구조는 보존하며 중복 키가 있으면 SQL 가져오기를 중단합니다. 인코딩과 SQL 특수문자를 보존하기 위해 문자열은 UTF-8 HEX로 내보냅니다. 계정·세션·연동 토큰·작업·검수·샘플·원본 파일은 포함되지 않습니다. 샘플 ID는 참조값만 유지하며 샘플 기능이 이전될 때 파일을 함께 반입해야 합니다. **기존 Pilot 계정의 자동 이전은 구현하지 않았으므로 제품판에서 관리자를 만들고 사용자는 다시 가입해야 합니다.** 비밀번호 해시 형식은 Pilot과 호환되지 않습니다.

## 검증

이번 실행 결과와 환경 제약은 [검증 기록](VERIFICATION.md)에 정리했습니다.

```sh
mvn -B -ntp -f product/was/pom.xml test
node --test product/scripts/export-pilot.test.js
# 반드시 테스트 전용 빈 제품 DB에서 실행. 관리자·사용자·서식을 생성하고 상태를 변경합니다.
# PRODUCT_TEST_ORIGIN=http://localhost:8088 및 FORMREADER_SETUP_TOKEN을 테스트 환경에 설정
node --test product/scripts/smoke.test.js
```

`/api/health`는 WAS 생존 확인, `/api/ready`는 MariaDB 스키마 연결 확인입니다. 인증·서식 동작, 초기 설정 토큰·origin 제한, 가입 승인·권한, 세션 만료·해제, 비밀번호 변경, 트랜잭션·동시 버전 증가·복원, 로컬 PDF.js MIME을 검증합니다. 기존 `npm test`는 Pilot 회귀 검증입니다.

## 후속 이전 범위

1. TextSense REST 클라이언트, 입력 전달과 공유 폴더/FTP 결과 수신, 작업 큐·폴링·재처리·취소.
2. OCR 결과 정규화·추출·분류, 검수, 문서 분리·비교, 샘플 파일 저장.
3. PDF/XLSX 등 내보내기, 업무 전송과 재시도, 운영 지표·정책·초기화.
4. Pilot 작업·파일·계정의 정식 마이그레이션과 모든 기존 기능의 Java 종단 검증.
5. 고객망 OS·승인 버전·컨테이너 허용 여부·내부 OCR 주소·공유 저장소·포트 정책에 맞춘 납품 패키징.

Java 전환판의 정규식 검증은 Java `Pattern` 기준입니다. JavaScript 전용 정규식 문법은 동일 동작을 보장하지 않으며 OCR 추출기 이전 단계에서 호환성을 확인해야 합니다. 현재 제품판 화면은 OCR 관련 메뉴와 샘플 OCR을 비활성화하며, 서식의 좌표·규칙 저장과 계정 관리를 검증하는 용도입니다.

설계 근거: [Tomcat 10.1 / Servlet 6](https://tomcat.apache.org/tomcat-10.1-doc/index.html), [Tomcat JNDI DataSource](https://tomcat.apache.org/tomcat-10.1-doc/jndi-datasource-examples-howto.html), [MariaDB Connector/J](https://mariadb.com/docs/connectors/mariadb-connector-j/about-mariadb-connector-j), [Nginx reverse proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
