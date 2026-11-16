'use strict';
/** 개별기능[ocr-connect]: OCR 서버 연결 점검 서비스 (textsense.py 와 동일한 build 요청 + 상태 조회) */

class OcrConnectService {
  constructor({ config, client }) {
    this.config = config;
    this.client = client;
  }

  /** 화면 표시용 접속 정보 (민감정보 없음) */
  getConnectionInfo() {
    const { textsense, storage, publicUrl, ftp } = this.config;
    const auto = String(publicUrl).toLowerCase() === 'auto';
    return {
      mode: this.config.mockMode ? 'mock' : 'live',
      endpoint: `http://${textsense.host}:${textsense.port}${textsense.buildPath}`,
      statusEndpoint: `http://${textsense.host}:${textsense.port}${textsense.statusPath}`,
      engineUrl: textsense.engineUrl,
      taskName: textsense.taskName,
      // 입력: HTTP(이 PC 가 파일 제공) 또는 ePapyrus 공유 경로 / 출력: 내장 FTP 수신 또는 ePapyrus 공유 경로
      inputUri: publicUrl ? `${auto ? 'http://<이 PC 주소 자동 감지>:' + (this.config.httpPort || this.config.port) : publicUrl}/files/input (HTTP)` : storage.inputUri,
      outputUri: ftp.enabled ? `ftp://<${ftp.publicHost === 'auto' ? '이 PC 주소 자동 감지' : ftp.publicHost}>:${ftp.port}/ (내장 FTP 수신)` : storage.outputUri,
    };
  }

  /**
   * 연결 테스트: textsense.py 와 같은 샘플 job build 요청을 보내고,
   * 응답으로 받은 작업 id 로 status API 까지 호출해 전 구간을 점검한다.
   * HTTP 응답을 받으면 연결 성공(reachable) 으로 본다.
   */
  async testConnection({ inputFile = 'pdf.pdf', outputFile = 'connection-test.json' } = {}) {
    const { storage } = this.config;
    const startedAt = Date.now();
    const base = { ...this.getConnectionInfo(), checkedAt: new Date().toISOString() };
    try {
      const res = await this.client.buildJob({
        inputUri: `${storage.inputUri}/${inputFile}`,
        outputUri: `${storage.outputUri}/${outputFile}`,
      });
      const result = {
        ...base,
        reachable: true,
        httpStatus: res.status,
        accepted: res.status >= 200 && res.status < 300,
        response: res.json !== null ? res.json : res.text,
      };

      const taskId = res.json && res.json.id;
      if (result.accepted && taskId) {
        try {
          const st = await this.client.getStatus(taskId);
          result.statusCheck = { httpStatus: st.status, status: st.json && st.json.status };
        } catch (err) {
          result.statusCheck = { error: err.message };
        }
      }
      result.elapsedMs = Date.now() - startedAt;
      return result;
    } catch (err) {
      return {
        ...base,
        reachable: false,
        accepted: false,
        elapsedMs: Date.now() - startedAt,
        error: { code: err.code || 'ERROR', message: err.message },
      };
    }
  }
}

module.exports = { OcrConnectService };
