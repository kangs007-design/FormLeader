'use strict';
/**
 * 웹 공통: 입력 검증 표시 (로그인/가입 화면과 업무 화면에서 함께 사용)
 *  - 빨간 테두리(.is-invalid) + 입력창 아래 오류 문구(.field-error)로 통일해서 보여 준다.
 *  - 사용자가 다시 입력하면 해당 칸의 오류는 자동으로 지워진다.
 */
window.FR = window.FR || {};

(() => {
  /** 받침 유무에 따라 을/를 선택 */
  const eulReul = (word) => {
    const code = word.charCodeAt(word.length - 1);
    return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '을' : '를';
  };
  const eunNeun = (word) => (eulReul(word) === '을' ? '은' : '는');
  const MSG = {
    required: (label) => `${label}${eulReul(label)} 입력해 주세요.`,
    email: '올바른 이메일 형식으로 입력하세요.',
    url: '올바른 주소(https://…) 형식으로 입력하세요.',
    min: (label, n) => `${label}${eunNeun(label)} ${n}자 이상 입력해 주세요.`,
    max: (label, n) => `${label}${eunNeun(label)} ${n}자 이내로 입력해 주세요.`,
    pattern: (label) => `${label} 형식이 올바르지 않습니다.`,
  };

  /** 오류 문구를 놓을 위치: 비밀번호 표시 버튼처럼 입력창을 감싼 요소가 있으면 그 뒤 */
  const anchorOf = (input) => input.closest('.password-input') || input;
  const boxOf = (input) => input.closest('.password-input') || input;
  const labelOf = (input) => {
    if (input.dataset.label) return input.dataset.label;
    const label = (input.labels && input.labels[0]) || input.closest('label');
    const text = label ? label.cloneNode(true) : null;
    if (text) text.querySelectorAll('input,select,textarea,.optional,span,.field-error').forEach((n) => n.remove());
    return (text && text.textContent.trim()) || input.getAttribute('aria-label') || '값';
  };
  const errorNodeOf = (input) => {
    const id = input.dataset.errorId;
    return id ? document.getElementById(id) : null;
  };

  /** 입력칸에 오류 표시. message 가 비면 오류 해제 */
  FR.setFieldError = function setFieldError(input, message) {
    if (!input) return;
    let node = errorNodeOf(input);
    if (!message) {
      boxOf(input).classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      if (node) node.hidden = true;
      return;
    }
    if (!node) {
      node = document.createElement('p');
      node.className = 'field-error';
      node.id = `err-${input.id || Math.random().toString(36).slice(2)}`;
      node.setAttribute('role', 'alert');
      input.dataset.errorId = node.id;
      anchorOf(input).after(node);
      input.addEventListener('input', () => FR.setFieldError(input, ''));
      input.addEventListener('change', () => FR.setFieldError(input, ''));
    }
    node.textContent = message;
    node.hidden = false;
    boxOf(input).classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', node.id);
  };

  FR.clearFieldErrors = function clearFieldErrors(root = document) {
    root.querySelectorAll('[data-error-id]').forEach((input) => FR.setFieldError(input, ''));
  };

  /** 브라우저 기본 제약(required/type/minlength/maxlength/pattern)을 한국어 문구로 */
  function nativeMessage(input) {
    const v = input.validity;
    if (v.valid) return '';
    const label = labelOf(input);
    if (v.valueMissing) return MSG.required(label);
    if (v.typeMismatch) return input.type === 'url' ? MSG.url : MSG.email;
    if (v.tooShort) return MSG.min(label, input.minLength);
    if (v.tooLong) return MSG.max(label, input.maxLength);
    if (v.patternMismatch) return input.title || MSG.pattern(label);
    return input.validationMessage;
  }

  /**
   * 입력칸들을 한꺼번에 검사한다. 오류는 모두 표시하고 첫 오류 칸에 포커스를 둔다.
   * @param {HTMLElement[]} inputs 검사할 칸 (숨겨진 칸은 건너뜀)
   * @param {Array<{input:HTMLElement, check:(value:string)=>string}>} rules 추가 규칙 (오류 문구 반환, 통과면 빈 문자열)
   * @returns {boolean} 모두 통과하면 true
   */
  FR.validateFields = function validateFields(inputs, rules = []) {
    let first = null;
    const failed = new Set();
    const fail = (input, message) => { FR.setFieldError(input, message); failed.add(input); if (!first) first = input; };
    for (const input of inputs) {
      if (!input || input.closest('[hidden]')) { FR.setFieldError(input, ''); continue; }
      const message = nativeMessage(input);
      if (message) fail(input, message); else FR.setFieldError(input, '');
    }
    for (const { input, check } of rules) {
      if (!input || failed.has(input)) continue;
      if (input.closest('[hidden]')) { FR.setFieldError(input, ''); continue; }
      const message = check(input.value);
      if (message) fail(input, message); else FR.setFieldError(input, '');
    }
    if (first) first.focus();
    return !first;
  };

  /** form 안의 모든 입력을 검사하고, 기본 브라우저 말풍선은 꺼 둔다 */
  FR.validateForm = function validateForm(form, rules = []) {
    form.noValidate = true;
    return FR.validateFields([...form.querySelectorAll('input:not([type=hidden]):not([type=checkbox]), select, textarea')], rules);
  };
})();
