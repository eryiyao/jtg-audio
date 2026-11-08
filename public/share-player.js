'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const base = location.pathname.replace(/\/$/, '');
  const audio = $('guest-audio');
  const gate = $('share-gate');
  const content = $('guest-content');
  const form = $('unlock-form');
  const error = $('guest-error');
  const status = $('guest-play-status');
  const seek = $('guest-seek');
  const storageKey = `jtg-share-position:${base}`;
  let authorized = false, terminal = false, deadline = 0, expiryTimer, checking;
  let version = 0, intent = 0, savedAt = 0;
  const format = (value) => {
    const seconds = Math.max(0, Math.floor(value || 0));
    return (seconds >= 3600 ? Math.floor(seconds / 3600) + ':' : '') +
      String(Math.floor(seconds / 60) % 60).padStart(seconds >= 3600 ? 2 : 1, '0') + ':' + String(seconds % 60).padStart(2, '0');
  };
  function save() {
    if (!authorized || !Number.isFinite(audio.currentTime)) return;
    try { localStorage.setItem(storageKey, String(audio.ended ? 0 : audio.currentTime)); } catch (_) {}
  }
  function stop(message, permanent) {
    save();
    version++; intent++;
    authorized = false;
    terminal = permanent;
    clearTimeout(expiryTimer);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    content.hidden = true;
    gate.hidden = false;
    form.hidden = permanent;
    $('gate-title').textContent = permanent ? '分享已失效' : '收听分享';
    $('gate-description').textContent = permanent ? '请联系分享者重新发送链接。' : '输入分享者提供的密码，即可收听。';
    error.textContent = message;
  }
  function allowed() {
    if (authorized && performance.now() >= deadline) stop('链接已到期，无法继续收听。', true);
    return authorized;
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '暂时无法收听'), { status: response.status });
    return data;
  }
  function accept(data, requestedAt) {
    // Subtract the full round trip conservatively; slow responses must not extend access.
    const remaining = data.expiresAt - data.serverNow - Math.max(0, performance.now() - requestedAt);
    if (remaining <= 0) { stop('链接已到期，无法继续收听。', true); return false; }
    authorized = true;
    deadline = performance.now() + remaining;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => stop('链接已到期，无法继续收听。', true), remaining);
    gate.hidden = true;
    content.hidden = false;
    $('guest-title').textContent = data.title;
    $('guest-expiry').textContent = `有效期至 ${new Date(data.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`;
    if (!audio.getAttribute('src')) {
      audio.src = data.audioUrl;
      audio.playbackRate = Number($('guest-speed').value);
      if ('mediaSession' in navigator && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: data.title, artist: 'JTG Audio' });
    }
    return true;
  }
  function check() {
    if (terminal) return Promise.resolve(false);
    if (checking) return checking;
    const current = version;
    const requestedAt = performance.now();
    checking = (async () => {
      try {
        const data = await request(base + '/session');
        return current === version && accept(data, requestedAt);
      } catch (failure) {
        if (current !== version) return false;
        if ([401, 404, 410].includes(failure.status)) stop(failure.status === 401 ? '' : failure.message, failure.status !== 401);
        else {
          save(); authorized = false; audio.pause();
          if (content.hidden) { form.hidden = false; error.textContent = '连接失败，请检查网络后重试。'; }
          else status.textContent = '连接中断，点击播放重试。';
        }
        return false;
      } finally { checking = null; }
    })();
    return checking;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('unlock-button');
    button.disabled = true;
    error.textContent = '正在验证…';
    try {
      await request(base + '/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JTG-Request': '1' },
        body: JSON.stringify({ password: $('guest-password').value }) });
      $('guest-password').value = '';
      await check();
    } catch (failure) {
      if ([404, 410].includes(failure.status)) stop(failure.message, true);
      else error.textContent = failure.status ? failure.message : '连接失败，请检查网络后重试。';
    } finally { button.disabled = false; }
  });
  async function play() {
    const current = ++intent;
    if (!await check() || current !== intent || !allowed()) return;
    status.textContent = '';
    try { await audio.play(); } catch (_) { if (authorized) status.textContent = '暂时无法播放，请重试。'; }
  }
  function pause() { intent++; audio.pause(); save(); }
  $('guest-play').addEventListener('click', () => audio.paused ? play() : pause());
  function move(value) { if (allowed() && Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, Math.max(0, value)); }
  $('guest-back').addEventListener('click', () => move(audio.currentTime - 15));
  $('guest-forward').addEventListener('click', () => move(audio.currentTime + 15));
  seek.addEventListener('input', () => { move(Number(seek.value)); update(); });
  seek.addEventListener('change', save);
  $('guest-speed').addEventListener('change', () => {
    audio.playbackRate = Number($('guest-speed').value);
    $('guest-speed-value').textContent = `${audio.playbackRate}×`;
  });
  audio.addEventListener('loadedmetadata', () => {
    if (!allowed()) return;
    let saved = 0;
    try { saved = Number(localStorage.getItem(storageKey)); } catch (_) {}
    if (Number.isFinite(saved) && saved > 0 && saved < audio.duration - 1) audio.currentTime = saved;
    update();
  });
  function update() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    seek.disabled = !duration;
    seek.max = String(duration || 100);
    seek.value = String(audio.currentTime || 0);
    seek.style.setProperty('--played', `${duration ? audio.currentTime / duration * 100 : 0}%`);
    $('guest-position').textContent = format(audio.currentTime);
    $('guest-duration').textContent = format(duration);
    if (navigator.mediaSession?.setPositionState && duration) {
      try { navigator.mediaSession.setPositionState({ duration, position: Math.min(duration, audio.currentTime), playbackRate: audio.playbackRate }); } catch (_) {}
    }
  }
  function playingState() {
    const playing = !audio.paused;
    $('guest-play').setAttribute('aria-pressed', String(playing));
    $('guest-play').setAttribute('aria-label', playing ? '暂停' : '播放');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
  audio.addEventListener('play', () => { if (!allowed()) audio.pause(); playingState(); });
  audio.addEventListener('pause', () => { save(); playingState(); });
  audio.addEventListener('ended', () => { save(); playingState(); });
  audio.addEventListener('timeupdate', () => {
    if (!allowed()) return;
    update();
    if (performance.now() - savedAt > 1000) { save(); savedAt = performance.now(); }
  });
  audio.addEventListener('error', () => {
    if (authorized) check().then((ok) => { if (ok) status.textContent = '音频暂时无法加载，请刷新重试。'; });
  });
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { save(); if (document.visibilityState === 'visible') check(); });
  setInterval(() => { if (authorized) { allowed(); if (authorized) check(); } }, 10000);
  if ('mediaSession' in navigator) {
    for (const [action, handler] of Object.entries({ play, pause,
      seekbackward: () => move(audio.currentTime - 15), seekforward: () => move(audio.currentTime + 15),
      seekto: (event) => move(event.seekTime) })) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
    }
  }
  check();
})();
