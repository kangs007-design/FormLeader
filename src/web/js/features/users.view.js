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
      return FR.el('tr', {},
        FR.el('td', {}, FR.el('div', { class: 'user-cell' }, FR.el('span', { class: 'user-table-avatar', 'aria-hidden': 'true' }, user.name.slice(0, 1)), FR.el('div', {}, FR.el('strong', {}, user.name, self ? FR.el('span', { class: 'current-user-tag' }, '나') : ''), FR.el('small', {}, user.email)))),
        FR.el('td', {}, user.department || '—'),
        FR.el('td', {}, user.role === 'admin' ? '관리자' : '일반 사용자'),
        FR.el('td', {}, FR.el('span', { class: `user-status ${user.status}` }, statuses[user.status])),
        FR.el('td', {}, FR.shortDate(user.createdAt)),
        FR.el('td', {}, FR.el('div', { class: 'user-row-actions' }, role, status, button)));
    }));
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
