'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('share-dialog');
  const form = $('share-form');
  const result = $('share-result');
  const status = $('share-status');
  const secrets = new Map(); // Never persist plaintext passwords in browser storage.
  let episode, share, generation = 0;
  const date = (value) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  async function request(url, options = {}) {
    const res = await window.JtgSession.request(url, options);
    const data = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(data?.error || '操作失败，请稍后重试');
    return data;
  }
  function render(data) {
    share = data.share;
    const active = share?.active;
    form.hidden = !!active;
    result.hidden = !active;
    if (!active) return;
    $('share-expiry').textContent = `${date(share.expiresAt)} 到期后失效`;
    $('share-url').value = location.origin + share.path;
    const secret = secrets.get(share.id);
    $('share-secret-row').hidden = !secret;
    $('share-secret').textContent = secret || '';
    $('share-secret-help').textContent = secret ? '请将链接和密码一起发给对方。' : '密码仅在生成时显示。忘记密码可撤销后重新生成。';
    $('copy-share').textContent = secret ? '复制链接和密码' : '复制链接';
  }
  window.ShareManager = { async open(ep) {
    const version = ++generation;
    episode = ep;
    share = null;
    $('share-episode-title').textContent = ep.title;
    form.reset();
    form.hidden = result.hidden = true;
    status.textContent = '正在读取分享设置…';
    dialog.showModal();
    try {
      const data = await request(`/api/episodes/${ep.id}/share`);
      if (version !== generation) return;
      status.textContent = '';
      render(data);
    } catch (error) { if (version === generation) status.textContent = error.message; }
  } };
  $('close-share').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; $('share-password').value = ''; });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const version = generation;
    const button = $('create-share');
    button.disabled = true;
    status.textContent = '正在生成…';
    try {
      const data = await request(`/api/episodes/${episode.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationHours: Number($('share-duration').value), password: $('share-password').value }) });
      secrets.set(data.share.id, data.password);
      if (version !== generation) return;
      $('share-password').value = '';
      render(data);
      status.textContent = '分享已生成';
      $('copy-share').focus();
    } catch (error) { if (version === generation) status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('copy-share').addEventListener('click', async () => {
    const version = generation;
    const secret = secrets.get(share.id);
    const text = secret ? `${episode.title}\n${$('share-url').value}\n分享密码：${secret}\n有效期至 ${date(share.expiresAt)}` : $('share-url').value;
    try {
      await navigator.clipboard.writeText(text);
      if (version === generation) status.textContent = secret ? '链接和密码已复制' : '链接已复制';
    } catch (_) {
      if (version !== generation) return;
      $('share-url').focus(); $('share-url').select();
      status.textContent = '无法自动复制，请长按链接和密码复制';
    }
  });
  $('revoke-share').addEventListener('click', async () => {
    const version = generation;
    const button = $('revoke-share');
    const id = share.id;
    button.disabled = true;
    status.textContent = '正在撤销…';
    try {
      await request(`/api/episodes/${episode.id}/share/${id}`, { method: 'DELETE' });
      secrets.delete(id);
      if (version !== generation) return;
      render({ share: null });
      status.textContent = '已撤销，原链接无法继续收听';
    } catch (error) { if (version === generation) status.textContent = error.message; }
    finally { button.disabled = false; }
  });
})();
