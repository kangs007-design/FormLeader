'use strict';
FR.accountView = (() => {
  async function authRequest(path, body) {
    const response = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TextSense' }, body: JSON.stringify(body || {}) });
    const data = await response.json();
    if (!response.ok) {
      const messages = { INVALID_PASSWORD: '현재 비밀번호가 올바르지 않습니다.', PASSWORD_TOO_SHORT: '새 비밀번호는 12자 이상 입력해 주세요.', PASSWORD_TOO_LONG: '새 비밀번호는 128자 이내로 입력해 주세요.' };
      throw Object.assign(new Error(messages[data.code] || (response.status === 429 ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.' : data.message) || '요청을 처리하지 못했습니다.'), { code: data.code });
    }
    return data;
  }

  async function init() {
    const info = await FR.api('GET', '/api/account/me');
    const user = info.user;
    FR.productCapabilities = info.capabilities || null;
    FR.currentUser = user;
    const admin = user.role === 'admin';
    document.querySelectorAll('[data-admin-only], .sidebar-tip, #or-goto-form, .upload-guide>.text-button').forEach((element) => { element.hidden = !admin; });
    FR.$('#current-user-name').textContent = user.name;
    FR.$('#current-user-role').textContent = admin ? '관리자' : '일반 사용자';
    FR.$('#current-user-avatar').textContent = user.name.slice(0, 1).toUpperCase();
    FR.$('#mode-notice').hidden = info.mode !== 'mock';
    const dialog = FR.$('#profile-dialog');
    const dl = FR.$('#profile-info');
    for (const [name, value] of [['이름', user.name], ['이메일', user.email], ['소속', user.department || '—'], ['권한', admin ? '관리자' : '일반 사용자']]) dl.append(FR.el('dt', {}, name), FR.el('dd', {}, value));
    FR.$('#profile-open').addEventListener('click', () => dialog.showModal());
    FR.$('#profile-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { FR.$('#password-change-form').reset(); FR.clearFieldErrors(dialog); FR.$('#profile-message').textContent = ''; });
    FR.$('#password-change-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = FR.$('#profile-message');
      FR.setMsg(message, '');
      const newPassword = FR.$('#profile-new-password');
      const confirmPassword = FR.$('#profile-password-confirm');
      if (!FR.validateForm(event.currentTarget, [{ input: confirmPassword, check: (v) => (v !== newPassword.value ? '동일한 비밀번호를 입력해 주세요.' : '') }])) return;
      const button = FR.$('#profile-password-submit');
      button.disabled = true;
      try {
        await authRequest('change-password', { currentPassword: FR.$('#profile-current-password').value, newPassword: FR.$('#profile-new-password').value, revokeOtherSessions: true });
        FR.$('#password-change-form').reset();
        FR.setMsg(message, '비밀번호를 변경했습니다. 다른 기기의 로그인은 종료됩니다.');
      } catch (e) {
        const field = { INVALID_PASSWORD: FR.$('#profile-current-password'), PASSWORD_TOO_SHORT: newPassword, PASSWORD_TOO_LONG: newPassword }[e.code];
        if (field) FR.setFieldError(field, e.message); else FR.setMsg(message, e.message, false);
      } finally { button.disabled = false; }
    });
    FR.$('#logout-button').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await authRequest('sign-out'); location.replace('/login'); }
      catch (e) { button.disabled = false; alert(e.message); }
    });
    setInterval(() => { FR.api('GET', '/api/account/me').catch(() => {}); }, 60000);
  }
  return { init };
})();
