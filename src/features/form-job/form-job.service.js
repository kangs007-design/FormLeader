'use strict';
/**
 * 개별기능[form-job]: Form 작업 (파일 업로드 → TextSense 작업 요청 → 상태 폴링 → 결과 JSON 수신 → 서식 적용)
 * 작업 상태: pending → processing → done | failed
 * TextSense 상태: AWAITING / PROGRESSING / SUCCESS / FAILURE (engineStatus 로 보관)
 */
const fs = require('fs');
const path = require('path');
const { JsonFileRepository } = require('../../common/json-file.repository');
const { createId, toSafeFileName } = require('../../common/id.util');
const { getImageSize } = require('../../common/image-size.util');
const { detectLocalAddress } = require('../../common/local-address.util');
const { AppError } = require('../../common/app.error');
const { createLogger } = require('../../common/logger.util');

const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp'];
const MAX_TRANSIENT_STATUS_ERRORS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FormJobService {
  constructor({ config, client, ocrResultService, formTemplateService }) {
    this.config = config;
    this.client = client;
    this.ocrResultService = ocrResultService;
    this.formTemplateService = formTemplateService;
    this.repo = new JsonFileRepository(path.join(config.dataDir, 'form-jobs.json'));
    this.log = createLogger('form-job');
    this.running = new Set(); // 테스트/종료 시 완료 대기용
  }

  /** 목록용: 큰 값(추출 Key-Value)은 빼고 화면 표시에 필요한 요약(result)만 포함 */
  list() {
    return this.repo.list().then((l) => l.map(({ ocrResult, ...summary }) => ({
      ...summary,
      result: ocrResult ? {
        classified: !!ocrResult.classified, docType: ocrResult.docType || null, needsReview: !!ocrResult.needsReview,
        pageCount: ocrResult.pageCount, wordCount: ocrResult.wordCount, tableCount: ocrResult.tableCount,
      } : null,
    })));
  }

  async get(id) {
    const job = await this.repo.get(id);
    if (!job) throw AppError.notFound(`작업을 찾을 수 없습니다: ${id}`);
    return job;
  }

  async remove(id) {
    await this.get(id);
    await this.repo.remove(id);
    return { id };
  }

  /** 파일을 저장하고 작업을 등록한 뒤, OCR 처리는 백그라운드로 시작한다. */
  async create({ fileName, contentBase64, templateId }) {
    const safeName = toSafeFileName(fileName);
    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) throw AppError.badRequest(`지원하지 않는 파일 형식입니다: ${ext || '(없음)'} (허용: ${ALLOWED_EXT.join(', ')})`);
    if (!contentBase64 || typeof contentBase64 !== 'string') throw AppError.badRequest('파일 내용(contentBase64)이 필요합니다.');
    if (templateId) await this.formTemplateService.get(templateId);

    const id = createId('job');
    const storedName = `${id}${ext}`;
    const { inputDir } = this.config.storage;
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, storedName), Buffer.from(contentBase64, 'base64'));

    const now = new Date().toISOString();
    const job = await this.repo.insert({
      id, fileName: safeName, storedName, templateId: templateId || null,
      status: 'pending', engineStatus: null, taskId: null, error: null, ocrResult: null, createdAt: now, updatedAt: now,
    });

    const p = this.run(id).catch((e) => this.log.error('작업 실행 오류', id, e.message)).finally(() => this.running.delete(p));
    this.running.add(p);
    return job;
  }

  async _patch(id, patch) {
    return this.repo.update(id, { updatedAt: new Date().toISOString(), ...patch });
  }

  /** TextSense 서버가 접속할 이 PC 의 주소. 'auto' 면 TextSense 로 나가는 경로의 주소를 매번 감지 (VPN 재접속 대응) */
  async _publicHost(configured) {
    if (configured && configured !== 'auto') return configured;
    return detectLocalAddress(this.config.textsense.host, this.config.textsense.port);
  }

  /** 입력 파일 URI: FORMREADER_PUBLIC_URL 이 있으면 HTTP, 없으면 ePapyrus 공유 경로(file) */
  async _inputUri(storedName) {
    const { publicUrl, storage } = this.config;
    if (!publicUrl) return `${storage.inputUri}/${storedName}`;
    if (String(publicUrl).toLowerCase() !== 'auto') return `${publicUrl}/files/input/${storedName}`;
    return `http://${await this._publicHost('auto')}:${this.config.httpPort || this.config.port}/files/input/${storedName}`;
  }

  /** 결과 파일 URI: FTP 수신기가 켜져 있으면 ftp:// (TextSense 가 이 프로그램으로 업로드), 아니면 ePapyrus 공유 경로 */
  async _outputUri(name) {
    const { ftp, storage } = this.config;
    if (!ftp.enabled) return `${storage.outputUri}/${name}`;
    const host = await this._publicHost(ftp.publicHost);
    return `ftp://${encodeURIComponent(ftp.user)}:${encodeURIComponent(ftp.password)}@${host}:${ftp.port}/${name}`;
  }

  /** OCR 처리 본체 */
  async run(id) {
    try {
      const job = await this.get(id);
      await this._patch(id, { status: 'processing' });

      const outputName = `${id}.json`;
      const res = await this.client.buildJob({
        inputUri: await this._inputUri(job.storedName),
        outputUri: await this._outputUri(outputName),
        outputType: 'json',
      });
      if (res.status < 200 || res.status >= 300) {
        throw AppError.upstream(`TextSense 작업 요청 실패 (HTTP ${res.status})`, { response: res.text.slice(0, 500) });
      }
      const taskId = res.json && res.json.id;
      if (!taskId) throw AppError.upstream('TextSense 응답에 작업 id 가 없습니다.', { response: res.text.slice(0, 500) });
      await this._patch(id, { taskId, engineStatus: res.json.status || 'AWAITING' });

      const deadline = Date.now() + this.config.jobTimeoutMs;
      await this._waitForSuccess(id, taskId, deadline);
      const ocrRaw = await this._readOutputFile(outputName, this.config.outputFileWaitMs);

      const result = await this.ocrResultService.apply(ocrRaw, job.templateId, { pageSize: this._pageSize(job) });
      await this._patch(id, { status: 'done', ocrResult: result, error: null });
    } catch (err) {
      this.log.error('작업 실패', id, err.message);
      await this._patch(id, { status: 'failed', error: err.message }).catch(() => {});
    }
  }

  /** /job/status 를 폴링해 SUCCESS 가 될 때까지 대기. FAILURE 면 /job/errors 내용으로 실패 처리 */
  async _waitForSuccess(id, taskId, deadline) {
    let last = null;
    let transient = 0; // 연속된 일시적 조회 실패 횟수 (연결 끊김, 5xx). VPN 환경에서 한두 번 끊겨도 작업은 계속 진행 중일 수 있다.
    while (Date.now() < deadline) {
      let st;
      try {
        st = await this.client.getStatus(taskId);
        if (st.status >= 500) throw AppError.upstream(`상태 조회 실패 (HTTP ${st.status})`);
      } catch (err) {
        if (++transient > MAX_TRANSIENT_STATUS_ERRORS) throw err;
        this.log.warn(`상태 조회 일시 오류 (${transient}/${MAX_TRANSIENT_STATUS_ERRORS}): ${err.message}`);
        await sleep(this.config.jobPollIntervalMs);
        continue;
      }
      transient = 0;
      if (st.status === 404) throw AppError.upstream(`TextSense 에 작업이 없습니다 (id: ${taskId})`);
      if (st.status < 200 || st.status >= 300 || !st.json) throw AppError.upstream(`상태 조회 실패 (HTTP ${st.status})`, { response: st.text.slice(0, 300) });

      const status = st.json.status;
      if (status !== last) { last = status; await this._patch(id, { engineStatus: status }); }
      if (status === 'SUCCESS') return;
      if (status === 'FAILURE') throw AppError.upstream(await this._describeFailure(taskId));
      await sleep(this.config.jobPollIntervalMs);
    }
    throw AppError.timeout(`OCR 작업 대기 시간 초과 (${this.config.jobTimeoutMs}ms, 마지막 상태: ${last || '-'})`);
  }

  async _describeFailure(taskId) {
    try {
      const res = await this.client.getErrors(taskId);
      const list = res.json && Array.isArray(res.json.errors) ? res.json.errors : [];
      const msgs = list.map((e) => [e.code, String(e.message || String(e.cause || '').split('\n')[0]).replace(/\s*\n\s*/g, ' ')].filter(Boolean).join(': ')).filter(Boolean);
      if (msgs.length) return `TextSense 작업 실패 - ${msgs.join(' / ').slice(0, 500)}`;
    } catch (_) { /* 오류 조회 실패는 무시하고 기본 메시지 사용 */ }
    const hint = this.config.ftp.enabled
      ? '입력 파일(http)·결과 업로드(ftp)를 TextSense 서버가 이 PC 에서 접근할 수 있는지(방화벽/주소) 확인하세요.'
      : '입력/출력 경로가 TextSense 서버에서 접근 가능한지 확인하세요.';
    return `TextSense 작업 실패 (FAILURE). 오류 상세를 조회하지 못했습니다. ${hint}`;
  }

  /** 결과 JSON 파일을 읽는다. 공유 저장소 지연을 고려해 잠시 재시도(작성 중인 파일은 파싱 실패 → 재시도) */
  async _readOutputFile(outputName, waitMs) {
    const file = path.join(this.config.storage.outputDir, outputName);
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* 쓰는 중 */ }
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.config.jobPollIntervalMs, 500));
    }
    throw AppError.timeout(`작업은 성공했지만 결과 파일을 찾을 수 없습니다: ${file} (LOCAL_OUTPUT_DIR 이 ePapyrus 출력 경로와 같은 저장소인지 확인하세요)`);
  }

  /** 이미지 입력이면 헤더에서 픽셀 크기를 읽어 좌표 정규화에 사용 (PDF 는 null → 추정) */
  _pageSize(job) {
    try {
      const buf = fs.readFileSync(path.join(this.config.storage.inputDir, job.storedName));
      return getImageSize(buf);
    } catch (_) { return null; }
  }

  /** 완료된 작업의 페이지별 OCR 추출값 (텍스트 / 단어 / 표 / SearchAPI fields) */
  async getOcrView(id) {
    const job = await this.get(id);
    if (job.status !== 'done') throw AppError.badRequest(`아직 결과가 없습니다 (상태: ${job.status})`);
    const file = path.join(this.config.storage.outputDir, `${id}.json`);
    if (!fs.existsSync(file)) throw AppError.notFound(`결과 파일이 없습니다: ${file}`);
    return this.ocrResultService.view(JSON.parse(fs.readFileSync(file, 'utf8')), { pageSize: this._pageSize(job) });
  }

  /** 실행 중인 작업이 모두 끝날 때까지 대기 (테스트/종료용) */
  async idle() { while (this.running.size) await Promise.all([...this.running]); }
}

module.exports = { FormJobService };
