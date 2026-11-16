'use strict';
/**
 * 공통: 환경설정 로더 (.env 파일 + process.env)
 * 외부 라이브러리 없이 .env 를 파싱한다.
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const AUTO = 'auto'; // 주소를 접속 시점에 자동 감지 (VPN 처럼 주소가 바뀌는 환경)

function publicHostOf(url) {
  if (String(url).toLowerCase() === AUTO) return AUTO;
  try { return url ? new URL(url).hostname : ''; } catch (_) { return ''; }
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** 환경변수를 읽어 설정 객체를 만든다. overrides 로 테스트 시 값을 덮어쓴다. */
function createConfig(overrides = {}) {
  // 테스트/Mock 실행은 개발자 PC 의 .env 에 영향받지 않도록 FORMREADER_SKIP_DOTENV=1 로 격리한다.
  if (process.env.FORMREADER_SKIP_DOTENV !== '1') loadEnvFile(path.join(ROOT_DIR, '.env'));
  const env = process.env;
  const resolveDir = (p) => path.resolve(ROOT_DIR, p);

  const config = {
    rootDir: ROOT_DIR,
    port: toInt(env.FORMREADER_PORT, 3000),
    // TextSense 서버가 접근 가능한 DigitalLeader 주소 (예: http://192.168.0.10:3000). 설정하면 입력 파일을 http:// 로 전달한다.
    // 'auto' 로 두면 TextSense 서버로 나가는 경로의 이 PC 주소를 작업마다 자동 감지한다. (예: FORMREADER_PUBLIC_URL=auto)
    publicUrl: (env.FORMREADER_PUBLIC_URL || '').replace(/\/+$/, ''),
    dataDir: resolveDir(env.FORMREADER_DATA_DIR || './data'),
    webDir: path.join(ROOT_DIR, 'src', 'web'),
    textsense: {
      host: env.TEXTSENSE_HOST || '192.168.0.25',
      port: toInt(env.TEXTSENSE_PORT, 7777),
      buildPath: env.TEXTSENSE_BUILD_PATH || '/textsense/api/job/build',
      statusPath: env.TEXTSENSE_STATUS_PATH || '/textsense/api/job/status',
      errorsPath: env.TEXTSENSE_ERRORS_PATH || '/textsense/api/job/errors',
      engineUrl: env.TEXTSENSE_ENGINE_URL || 'http://textsense:8080',
      taskName: env.TEXTSENSE_TASK_NAME || 'simple-conversion-sample',
    },
    storage: {
      inputUri: (env.EPAPYRUS_INPUT_URI || 'file:///ePapyrus/data/input').replace(/\/+$/, ''),
      outputUri: (env.EPAPYRUS_OUTPUT_URI || 'file:///ePapyrus/data/output').replace(/\/+$/, ''),
      inputDir: resolveDir(env.LOCAL_INPUT_DIR || './data/input'),
      outputDir: resolveDir(env.LOCAL_OUTPUT_DIR || './data/output'),
    },
    // 내장 FTP 수신기: TextSense 가 결과 JSON 을 ftp:// 로 이 프로그램에 업로드하게 한다 (공유 폴더 불필요)
    ftp: {
      enabled: String(env.FTP_ENABLED || '').toLowerCase() === 'true',
      port: toInt(env.FTP_PORT, 2121),
      user: env.FTP_USER || 'formreader',
      password: env.FTP_PASSWORD || '', // 비어 있으면 실행할 때마다 임의 생성
      pasvMin: toInt(env.FTP_PASV_MIN, 50000),
      pasvMax: toInt(env.FTP_PASV_MAX, 50020),
      publicHost: env.FTP_PUBLIC_HOST || publicHostOf(env.FORMREADER_PUBLIC_URL),
    },
    // TextSense 작업 완료 콜백(callbackUri). 켜면 완료 즉시 알림을 받는다. (상태 폴링은 안전장치로 계속 동작)
    // 콜백은 TextSense 서버가 이 프로그램의 HTTP 주소로 POST 하므로 FORMREADER_PUBLIC_URL 이 필요하다.
    callback: { enabled: String(env.TEXTSENSE_CALLBACK || '').toLowerCase() === 'true' },
    requestTimeoutMs: toInt(env.REQUEST_TIMEOUT_MS, 15000),
    jobTimeoutMs: toInt(env.JOB_TIMEOUT_MS, 120000),
    jobPollIntervalMs: toInt(env.JOB_POLL_INTERVAL_MS, 1000),
    // 작업이 SUCCESS 가 된 뒤 결과 파일이 공유 저장소에 나타나길 기다리는 최대 시간
    outputFileWaitMs: toInt(env.OUTPUT_FILE_WAIT_MS, 30000),
  };

  return deepMerge(config, overrides);
}

module.exports = { createConfig };
