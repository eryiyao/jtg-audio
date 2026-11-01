'use strict';
const form = document.getElementById('login-form');
const password = document.getElementById('password');
const show = document.getElementById('show-password');
const button = document.getElementById('login-button');
const status = document.getElementById('login-status');
if (new URLSearchParams(location.search).has('expired')) status.textContent = '登录已失效，请重新输入密码。';
show.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  show.textContent = visible ? '隐藏' : '显示';
  show.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  show.setAttribute('aria-pressed', String(visible));
});
password.addEventListener('input', () => { password.removeAttribute('aria-invalid'); status.textContent = ''; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '正在登录…';
  status.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JTG-Request': '1' },
      body: JSON.stringify({ password: password.value, remember: document.getElementById('remember').checked }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) password.setAttribute('aria-invalid', 'true');
      throw new Error(data.error || '登录失败，请重试');
    }
    password.value = '';
    location.replace('/');
  } catch (error) {
    status.textContent = error instanceof TypeError ? '网络暂时不可用，请稍后重试' : error.message;
    button.disabled = false;
    button.textContent = '登录';
  }
});
