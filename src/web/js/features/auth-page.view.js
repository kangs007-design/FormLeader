'use strict';
(() => {
  const $ = (selector) => document.querySelector(selector);
  let mode = location.pathname === '/signup' ? 'signup' : location.pathname === '/setup' ? 'setup' : 'login';
  let setupTokenInput;
  const messages = {
    INVALID_EMAIL_OR_PASSWORD: '이메일 또는 비밀번호가 올바르지 않습니다.', INVALID_PASSWORD: '비밀번호가 올바르지 않습니다.',
    PASSWORD_TOO_SHORT: '비밀번호는 12자 이상 입력해 주세요.', PASSWORD_TOO_LONG: '비밀번호는 128자 이내로 입력해 주세요.',
    INVALID_EMAIL: '올바른 이메일 주소를 입력해 주세요.', USER_ALREADY_EXISTS: '이미 가입했거나 가입 신청한 이메일입니다. 로그인하거나 관리자에게 문의해 주세요.', TOO_MANY_REQUESTS: '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
  };
  const fieldOfError = (code) => ({
    INVALID_EMAIL: $('#auth-email'), USER_ALREADY_EXISTS: $('#auth-email'),
    INVALID_EMAIL_OR_PASSWORD: $('#auth-password'), INVALID_PASSWORD: $('#auth-password'),
    PASSWORD_TOO_SHORT: $('#auth-password'), PASSWORD_TOO_LONG: $('#auth-password'),
  })[code] || null;
  const showError = (message) => { $('#auth-error').textContent = message; $('#auth-error').hidden = false; };

  async function initialize() {
    try {
      const response = await fetch('/api/account/status', { cache: 'no-store' });
      const status = await response.json();
      if (!response.ok || !status.ok) throw new Error('계정 설정을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.');
      if (status.data.needsSetup && mode !== 'setup') { location.replace('/setup'); return; }
      if (!status.data.needsSetup && mode === 'setup') { location.replace('/login'); return; }
      const registering = mode !== 'login';
      const setup = mode === 'setup';
      if (setup && status.data.setupTokenRequired) {
        const group = document.createElement('div');
        group.className = 'auth-input-group';
        const label = document.createElement('label');
        label.htmlFor = 'auth-setup-token';
        label.textContent = '초기 설정 토큰';
        setupTokenInput = document.createElement('input');
        Object.assign(setupTokenInput, { id: 'auth-setup-token', type: 'password', required: true, autocomplete: 'off', placeholder: '운영자가 발급한 토큰을 입력하세요' });
        group.append(label, setupTokenInput);
        $('#account-form').prepend(group);
      }
      $('#auth-back').hidden = !registering || setup;
      $('#auth-eyebrow').textContent = setup ? 'LET’S GET STARTED' : registering ? 'JOIN YOUR TEAM' : 'WELCOME BACK';
      $('#auth-title').textContent = setup ? '첫 관리자 계정 만들기' : registering ? '함께 시작해 보세요.' : '다시 만나 반갑습니다.';
      $('#auth-description').textContent = setup ? '서버 PC에서 관리자 계정을 설정하고 시작하세요.' : registering ? '가입 신청 후 관리자 승인을 기다려 주세요.' : '계정으로 로그인하고 문서 작업을 이어가세요.';
      document.title = FR.brandTitle(setup ? '관리자 설정' : registering ? '가입 신청' : '로그인');
      document.querySelectorAll('.auth-register-field').forEach((field) => { field.hidden = !registering; });
      $('#auth-name').required = registering;
      $('#auth-confirm-group').hidden = !registering;
      $('#auth-password-confirm').required = registering;
      $('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
      $('#auth-password').minLength = registering ? 12 : 1;
      $('#auth-password-hint').hidden = !registering;
      $('#auth-signup-link').hidden = registering;
      $('#auth-forgot').hidden = registering;
      $('#auth-submit').replaceChildren(document.createTextNode(setup ? '관리자 계정 만들기' : registering ? '가입 신청하기' : '로그인'), Object.assign(document.createElement('span'), { textContent: '→' }));
      $('#auth-note').textContent = setup ? '이 계정으로 가입 승인과 사용자 권한을 관리합니다. 공용 비밀번호 대신 본인의 비밀번호를 설정해 주세요.' : '승인된 구성원만 문서를 열고 처리할 수 있습니다.';
      $('#auth-loading').hidden = true;
      $('#account-form').hidden = false;
    } catch (e) { $('#auth-loading').textContent = e.message; }
  }

  $('#password-toggle').addEventListener('click', () => {
    const visible = $('#auth-password').type === 'password';
    $('#auth-password').type = visible ? 'text' : 'password';
    $('#password-toggle').textContent = visible ? '숨김' : '표시';
    $('#password-toggle').setAttribute('aria-label', visible ? '비밀번호 숨김' : '비밀번호 표시');
  });
  $('#account-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#auth-error').hidden = true;
    const confirmInput = $('#auth-password-confirm');
    const valid = FR.validateForm($('#account-form'), mode === 'login' ? [] : [
      { input: confirmInput, check: (v) => (v !== $('#auth-password').value ? '동일한 비밀번호를 입력해 주세요.' : '') },
    ]);
    if (!valid) return;
    const button = $('#auth-submit');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const body = { email: $('#auth-email').value.trim(), password: $('#auth-password').value };
      if (mode !== 'login') { body.name = $('#auth-name').value.trim(); body.department = $('#auth-department').value.trim(); }
      const url = mode === 'setup' ? '/api/account/setup' : mode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TextSense', ...(setupTokenInput ? { 'X-Setup-Token': setupTokenInput.value } : {}) }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        const error = data.error || data;
        throw Object.assign(new Error(messages[error.code] || (response.status === 429 ? messages.TOO_MANY_REQUESTS : error.message) || '요청을 처리하지 못했습니다.'), { code: error.code });
      }
      if (mode === 'login') { location.replace('/'); return; }
      $('#account-form').hidden = true;
      $('#auth-success').hidden = false;
      $('#auth-name').value = ''; $('#auth-email').value = ''; $('#auth-password').value = ''; $('#auth-password-confirm').value = '';
      if (setupTokenInput) setupTokenInput.value = '';
      if (mode === 'setup') {
        $('#auth-success-title').textContent = '관리자 설정을 마쳤습니다.';
        $('#auth-success-description').textContent = '방금 만든 관리자 계정으로 로그인해 주세요.';
      }
    } catch (e) {
      // 입력칸에 해당하는 오류는 그 칸 아래에, 그 밖의 오류는 상단 안내 영역에 표시한다
      const field = fieldOfError(e.code);
      if (field) FR.setFieldError(field, e.message); else showError(e.message || '네트워크 연결을 확인해 주세요.');
    }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  });
  initialize();
})();
