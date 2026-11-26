'use strict';
FR.usersView = (() => {
  let users = [];
  let filter = 'all';
  let search = '';
  const statuses = { pending: '승인 대기', active: '활성', disabled: '비활성' };

  function render() {
    const body = FR.$('#users-body');
    FR.$('#users-total').textContent = users.length;
    FR.$('#users-active').textContent = users.filter((user) => user.status === 'active').length;
    FR.$('#users-pending').textContent = users.filter((user) => user.status === 'pending').length;
    const shown = users.filter((user) => (filter === 'all' || user.status === filter) && [user.name, user.email, user.department].join(' ').toLowerCase().includes(search));
    if (!shown.length) { body.replaceChildren(FR.emptyRow(6, '조건에 맞는 사용자가 없습니다.')); return; }
    body.replaceChildren(...shown.map((user) => {
      const self = user.id === FR.currentUser.id;
      const role = FR.el('select', { 'aria-label': `${user.name} 권한`, disabled: self },
        FR.el('option', { value: 'user', selected: user.role === 'user' }, '일반 사용자'), FR.el('option', { value: 'admin', selected: user.role === 'admin' }, '관리자'));
      const status = FR.el('select', { 'aria-label': `${user.name} 상태`, disabled: self }, Object.entries(statuses).map(([key, label]) => FR.el('option', { value: key, selected: user.status === key }, label)));
      const button = FR.el('button', { class: `sm${user.status === 'pending' ? ' primary' : ''}`, disabled: self, 'aria-label': `${user.name} ${user.status === 'pending' ? '가입 승인' : '권한 및 상태 저장'}`, onclick: async () => {
        button.disabled = true;
        try {
          const nextStatus = user.status === 'pending' && status.value === 'pending' ? 'active' : status.value;
          await FR.api('PUT', `/api/users/${encodeURIComponent(user.id)}`, { role: role.value, status: nextStatus });
          await load();
          FR.setMsg(FR.$('#users-message'), `${user.name} 사용자의 권한과 상태를 저장했습니다.`);
        } catch (e) { FR.setMsg(FR.$('#users-message'), e.message, false); button.disabled = false; }
      } }, self ? '본인 계정' : user.status === 'pending' ? '가입 승인' : '저장');
      const reset = !self && FR.features?.credentialReset
        ? FR.el('button', { class: 'sm', 'aria-label': `${user.name} 비밀번호 초기화`, onclick: () => resetPassword(user, reset) }, '비밀번호 초기화')
        : '';
      return FR.el('tr', {},
        FR.el('td', {}, FR.el('div', { class: 'user-cell' }, FR.el('span', { class: 'user-table-avatar', 'aria-hidden': 'true' }, user.name.slice(0, 1)), FR.el('div', {}, FR.el('strong', {}, user.name, self ? FR.el('span', { class: 'current-user-tag' }, '나') : ''), FR.el('small', {}, user.email)))),
        FR.el('td', { 'data-label': '소속' }, user.department || '—'),
        FR.el('td', { 'data-label': '권한' }, user.role === 'admin' ? '관리자' : '일반 사용자'),
        FR.el('td', { 'data-label': '상태' }, FR.el('span', { class: `user-status ${user.status}` }, statuses[user.status])),
        FR.el('td', { 'data-label': '가입일' }, FR.shortDate(user.createdAt)),
        FR.el('td', {}, FR.el('div', { class: 'user-row-actions' }, role, status, button, reset)));
    }));
  }

  /** 임시 비밀번호는 서버가 다시 알려주지 않으므로 닫기 전까지 화면에 보여 준다 */
  function showTemporaryPassword(result) {
    FR.$('#temp-password-dialog')?.remove();
    const message = FR.el('span', { class: 'msg', role: 'status' });
    const field = FR.el('input', { id: 'temp-password', class: 'temp-password', readonly: true, value: result.temporaryPassword, 'aria-label': '임시 비밀번호', onfocus: (e) => e.target.select() });
    const dialog = FR.el('dialog', { id: 'temp-password-dialog', class: 'profile-dialog' },
      FR.el('div', { class: 'dialog-head' }, FR.el('h2', {}, '임시 비밀번호'),
        FR.el('button', { class: 'icon-btn', 'aria-label': '임시 비밀번호 닫기', onclick: () => dialog.close() }, '✕')),
      FR.el('p', {}, `${result.name} (${result.email}) 님에게 전달해 주세요.`),
      field,
      FR.el('p', { class: 'hint' }, '이 창을 닫으면 다시 볼 수 없습니다. 로그인하면 새 비밀번호로 바꿔야 하며, 기존 로그인은 모두 종료되었습니다.'),
      FR.el('div', { class: 'dialog-actions' },
        FR.el('button', { class: 'primary', onclick: async () => {
          try { await navigator.clipboard.writeText(result.temporaryPassword); FR.setMsg(message, '복사했습니다.'); }
          catch (_) { field.select(); FR.setMsg(message, '복사할 수 없습니다. 선택된 값을 직접 복사하세요.', false); }
        } }, '복사'),
        message));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  async function resetPassword(user, button) {
    if (!confirm(`${user.name} 님의 비밀번호를 초기화할까요?\n기존 비밀번호와 로그인은 바로 사용할 수 없게 됩니다.`)) return;
    button.disabled = true;
    try {
      showTemporaryPassword(await FR.api('POST', `/api/users/${encodeURIComponent(user.id)}/reset-password`, {}));
      FR.setMsg(FR.$('#users-message'), `${user.name} 사용자의 비밀번호를 초기화했습니다.`);
    } catch (e) { FR.setMsg(FR.$('#users-message'), e.message, false); }
    finally { button.disabled = false; }
  }

  async function load() {
    try { users = await FR.api('GET', '/api/users'); render(); }
    catch (e) { FR.$('#users-body').replaceChildren(FR.emptyRow(6, e.message)); }
  }

  function init() {
    FR.$('#users-refresh').addEventListener('click', () => { FR.$('#users-message').textContent = ''; load(); });
    FR.$('#users-search').addEventListener('input', (event) => { search = event.target.value.trim().toLowerCase(); render(); });
    FR.$('#users-filters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      filter = button.dataset.filter;
      FR.$('#users-filters').querySelectorAll('button').forEach((candidate) => { candidate.classList.toggle('active', candidate === button); candidate.setAttribute('aria-pressed', String(candidate === button)); });
      render();
    });
  }
  return { init, load };
})();
