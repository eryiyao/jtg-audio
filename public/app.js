'use strict';

const POS_PREFIX = 'jtg-audio:pos:';
const CURRENT_KEY = 'jtg-audio:current';
const CLIENT_KEY = 'jtg-audio:client';

const listEl = document.getElementById('episode-list');
const emptyEl = document.getElementById('empty');
const listErrorEl = document.getElementById('list-error');
const form = document.getElementById('upload-form');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');
const fileInput = document.getElementById('file');
const fileName = document.getElementById('file-name');
const playerEl = document.getElementById('player');
const playBtn = document.getElementById('play-btn');
const nowTitle = document.getElementById('now-title');
const resumeNote = document.getElementById('resume-note');
const seekEl = document.getElementById('seek');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const playerError = document.getElementById('player-error');
const audio = document.getElementById('audio');
const uploadDialog = document.getElementById('upload-dialog');
const closeUpload = document.getElementById('close-upload');
const speedEl = document.getElementById('speed');

for (const button of document.querySelectorAll('[data-open-upload]')) {
  button.addEventListener('click', () => {
    uploadStatus.textContent = '';
    uploadDialog.showModal();
  });
}
closeUpload.addEventListener('click', () => uploadDialog.close());
uploadDialog.addEventListener('cancel', (event) => {
  if (uploadBtn.disabled) event.preventDefault();
});
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (!playerEl.hidden) document.documentElement.style.setProperty('--player-space', `${playerEl.offsetHeight + 32}px`);
  }).observe(playerEl);
}

let episodes = [];
let current = null;
let openToken = 0;
let positionReady = false;
let seeking = false;
let syncTimer = 0;
let latestSeconds = 0;

function clientKey() {
  let key = localStorage.getItem(CLIENT_KEY);
  if (!key || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) {
    key = crypto.randomUUID();
    localStorage.setItem(CLIENT_KEY, key);
  }
  return key;
}

function posKey(id) {
  return POS_PREFIX + id;
}

function readLocalPos(id) {
  const raw = localStorage.getItem(posKey(id));
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date);
}

function heardLabel(id) {
  const pos = readLocalPos(id);
  if (pos == null || pos < 1) return '准备收听';
  return `听到 ${formatTime(pos)}`;
}

async function loadEpisodes() {
  listErrorEl.textContent = '';
  const res = await fetch('/api/episodes');
  if (!res.ok) throw new Error('列表加载失败');
  episodes = await res.json();
  renderList();
}

function renderList() {
  listEl.replaceChildren();
  emptyEl.hidden = episodes.length > 0;
  document.getElementById('episode-count').textContent = String(episodes.length);
  document.getElementById('storage-total').textContent = episodes.length
    ? `音频共 ${formatSize(episodes.reduce((sum, ep) => sum + ep.sizeBytes, 0))}` : '暂无音频';
  for (const ep of episodes) {
    const item = document.createElement('li');
    item.className = 'item';
    if (current && current.id === ep.id) item.classList.add('is-active');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'episode';
    open.setAttribute('aria-label', `打开音频：${ep.title}`);
    open.addEventListener('click', () => {
      openEpisode(ep).catch(() => {
        playerError.textContent = '打不开这条音频';
      });
    });

    const title = document.createElement('span');
    title.className = 'ep-title';
    title.textContent = ep.title;

    const meta = document.createElement('span');
    meta.className = 'ep-meta';
    const bits = [formatDate(ep.createdAt), formatSize(ep.sizeBytes)];
    if (ep.durationSeconds) bits.push(formatTime(ep.durationSeconds));
    meta.textContent = bits.filter(Boolean).join(' · ');

    const heard = document.createElement('span');
    heard.className = 'ep-heard';
    heard.dataset.progressFor = ep.id;
    heard.textContent = heardLabel(ep.id);

    const art = document.createElement('span');
    art.className = 'ep-art';
    art.setAttribute('aria-hidden', 'true');
    art.textContent = '♪';
    const copy = document.createElement('span');
    copy.className = 'ep-copy';
    copy.append(title, meta, heard);
    open.append(art, copy);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `删除音频：${ep.title}`);
    remove.title = '删除音频并释放空间';
    remove.addEventListener('click', () => removeEpisode(ep).catch(() => {
      listErrorEl.textContent = '删除失败，请检查网络后重试';
    }));

    item.append(open, remove);
    listEl.append(item);
  }
}

function updateHeard(id) {
  for (const el of listEl.querySelectorAll('[data-progress-for]')) {
    if (el.dataset.progressFor === id) el.textContent = heardLabel(id);
  }
}

async function savedPosition(id) {
  const local = readLocalPos(id);
  if (local != null) return local;
  try {
    const res = await fetch(`/api/progress/${id}?clientKey=${encodeURIComponent(clientKey())}`);
    if (!res.ok) return 0;
    const data = await res.json();
    if (typeof data.positionSeconds === 'number') {
      localStorage.setItem(posKey(id), String(data.positionSeconds));
      return data.positionSeconds;
    }
  } catch (err) {
    // 服务端进度只是预留，失败不影响本机续播。
  }
  return 0;
}

async function openEpisode(ep) {
  if (current && current.id === ep.id && audio.getAttribute('src')) return;
  flushPosition();
  const token = ++openToken;
  positionReady = false;
  latestSeconds = 0;
  current = ep;
  localStorage.setItem(CURRENT_KEY, ep.id);
  playerError.textContent = '';
  resumeNote.textContent = '';
  playerEl.hidden = false;
  document.body.classList.add('has-player');
  nowTitle.textContent = ep.title;
  if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: 'JTG Audio' });
  }
  setPlaying(false);
  timeCurrent.textContent = '0:00';
  timeTotal.textContent = ep.durationSeconds ? formatTime(ep.durationSeconds) : '0:00';
  seekEl.value = '0';
  seekEl.disabled = true;
  audio.pause();
  audio.removeAttribute('src');
  audio.dataset.pendingSeek = '0';
  audio.dataset.readyApplied = '0';
  renderList();

  const saved = await savedPosition(ep.id);
  if (token !== openToken) return;
  resumeNote.textContent = saved >= 1 ? `从 ${formatTime(saved)} 继续` : '';
  audio.dataset.pendingSeek = String(saved || 0);
  audio.src = ep.audioUrl;
}

function applyPendingSeek() {
  if (!current || audio.dataset.readyApplied === '1') return;
  const token = openToken;
  const saved = Number(audio.dataset.pendingSeek || 0);
  const duration = audio.duration;
  const shouldSeek = saved > 0 && Number.isFinite(duration) && saved < duration;
  seekEl.disabled = !Number.isFinite(duration) || duration <= 0;
  playerError.textContent = '';

  const finish = () => {
    if (!current || token !== openToken || audio.dataset.readyApplied === '1') return;
    audio.dataset.readyApplied = '1';
    positionReady = true;
    latestSeconds = Number.isFinite(audio.currentTime) ? audio.currentTime : saved;
    updateTimes();
    rememberDuration(duration);
  };

  if (!shouldSeek) {
    finish();
    return;
  }

  let settled = false;
  const onSeeked = () => {
    if (settled) return;
    settled = true;
    audio.removeEventListener('seeked', onSeeked);
    finish();
  };
  audio.addEventListener('seeked', onSeeked);
  try {
    audio.currentTime = saved;
  } catch (err) {
    onSeeked();
    return;
  }
  setTimeout(onSeeked, 700);
}

function rememberDuration(duration) {
  if (!current || current.durationSeconds || !Number.isFinite(duration) || duration <= 0) return;
  const rounded = Math.round(duration * 10) / 10;
  current.durationSeconds = rounded;
  fetch(`/api/episodes/${current.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationSeconds: rounded }),
  }).then((res) => {
    if (res.ok) return res.json();
    return null;
  }).then((updated) => {
    if (!updated) return;
    const found = episodes.find((item) => item.id === updated.id);
    if (found) found.durationSeconds = updated.durationSeconds;
    renderList();
  }).catch(() => {});
}

function keepPosition(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 10) / 10;
}

function writeLocal(id, seconds) {
  localStorage.setItem(posKey(id), String(seconds));
  updateHeard(id);
}

function scheduleServerSync(id, seconds) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncServer(id, seconds), 800);
}

function syncServer(id, seconds) {
  fetch(`/api/progress/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionSeconds: seconds, clientKey: clientKey() }),
    keepalive: true,
  }).catch(() => {});
}

function persistPosition(seconds) {
  if (!positionReady || !current) return;
  const raw = Number.isFinite(seconds) ? seconds : audio.currentTime;
  const pending = Number(audio.dataset.pendingSeek || 0);
  if (pending >= 1 && raw < 0.5) return;
  const kept = keepPosition(raw);
  latestSeconds = kept;
  audio.dataset.pendingSeek = String(kept);
  writeLocal(current.id, kept);
  scheduleServerSync(current.id, kept);
}

function flushPosition() {
  if (!positionReady || !current) return;
  clearTimeout(syncTimer);
  const seconds = audio.ended ? 0 : keepPosition(
    Number.isFinite(audio.currentTime) ? audio.currentTime : latestSeconds
  );
  latestSeconds = seconds;
  audio.dataset.pendingSeek = String(seconds);
  writeLocal(current.id, seconds);
  syncServer(current.id, seconds);
}

function updateTimes() {
  const duration = audio.duration;
  timeCurrent.textContent = formatTime(audio.currentTime);
  timeTotal.textContent = Number.isFinite(duration) ? formatTime(duration) : '0:00';
  if (!seeking && Number.isFinite(duration) && duration > 0) {
    seekEl.value = String(Math.round((audio.currentTime / duration) * 1000));
  }
}

function setPlaying(isPlaying) {
  document.getElementById('play-icon').textContent = isPlaying ? 'Ⅱ' : '▶';
  document.getElementById('play-state').textContent = isPlaying ? '正在收听' : '准备收听';
  playBtn.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
  playBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

async function removeEpisode(ep) {
  const ok = window.confirm(`确定删除「${ep.title}」？文件会一起去掉。`);
  if (!ok) return;
  const res = await fetch(`/api/episodes/${ep.id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const error = await res.json().catch(() => ({}));
    listErrorEl.textContent = error.error || '删除失败，请稍后重试';
    return;
  }
  localStorage.removeItem(posKey(ep.id));
  if (current && current.id === ep.id) {
    clearTimeout(syncTimer);
    openToken += 1;
    current = null;
    positionReady = false;
    audio.pause();
    audio.removeAttribute('src');
    playerEl.hidden = true;
    document.body.classList.remove('has-player');
    localStorage.removeItem(CURRENT_KEY);
  }
  await loadEpisodes();
}

document.getElementById('pick-file').addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const chosen = fileInput.files[0];
  fileName.textContent = chosen ? chosen.name : '选择音频文件';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    uploadStatus.textContent = '请先选择音频';
    return;
  }
  uploadBtn.disabled = true;
  closeUpload.disabled = true;
  document.getElementById('pick-file').disabled = true;
  uploadBtn.textContent = '正在上传…';
  uploadStatus.textContent = '上传中…';
  try {
    const res = await fetch('/api/episodes', { method: 'POST', body: new FormData(form) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '上传失败');
    form.reset();
    fileName.textContent = '选择音频文件';
    uploadStatus.textContent = '已上传';
    await loadEpisodes();
    const created = episodes.find((item) => item.id === data.id);
    if (created) await openEpisode(created);
    uploadDialog.close();
  } catch (err) {
    uploadStatus.textContent = err.message || '上传失败';
  } finally {
    uploadBtn.disabled = false;
    closeUpload.disabled = false;
    document.getElementById('pick-file').disabled = false;
    uploadBtn.textContent = '上传到我的音频';
  }
});

function seekTo(seconds) {
  if (!positionReady || !Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(seconds)) return;
  const next = Math.max(0, Math.min(seconds, audio.duration));
  latestSeconds = next;
  audio.dataset.pendingSeek = String(next);
  audio.currentTime = next;
  resumeNote.textContent = '';
  persistPosition(next);
  updateTimes();
}
document.getElementById('back-btn').addEventListener('click', () => seekTo(audio.currentTime - 15));
document.getElementById('forward-btn').addEventListener('click', () => seekTo(audio.currentTime + 15));
speedEl.addEventListener('change', () => {
  const rate = Number(speedEl.value);
  if ([1, 1.25, 1.5, 2].includes(rate)) audio.playbackRate = rate;
});

playBtn.addEventListener('click', async () => {
  playerError.textContent = '';
  if (!current || !audio.getAttribute('src')) return;
  if (audio.paused) {
    try {
      await audio.play();
    } catch (err) {
      playerError.textContent = '无法播放';
    }
  } else {
    audio.pause();
  }
});

seekEl.addEventListener('input', () => {
  seeking = true;
  const duration = audio.duration;
  if (!Number.isFinite(duration)) return;
  timeCurrent.textContent = formatTime((seekEl.value / 1000) * duration);
});

seekEl.addEventListener('change', () => {
  const duration = audio.duration;
  seeking = false;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const next = (seekEl.value / 1000) * duration;
  latestSeconds = next;
  audio.dataset.pendingSeek = String(next);
  audio.currentTime = next;
  resumeNote.textContent = '';
  persistPosition(next);
});

audio.addEventListener('loadedmetadata', applyPendingSeek);
audio.addEventListener('play', () => {
  setPlaying(true);
  resumeNote.textContent = '';
});
audio.addEventListener('pause', () => {
  setPlaying(false);
  if (positionReady && audio.currentTime >= 0.5) latestSeconds = audio.currentTime;
  persistPosition(latestSeconds);
});
audio.addEventListener('timeupdate', () => {
  updateTimes();
  if (!positionReady || !current) return;
  if (audio.currentTime < 0.5 && latestSeconds >= 1) return;
  latestSeconds = audio.currentTime;
  const saved = readLocalPos(current.id);
  if (saved == null || Math.abs(latestSeconds - saved) >= 2) persistPosition(latestSeconds);
});
audio.addEventListener('ended', () => {
  setPlaying(false);
  clearTimeout(syncTimer);
  latestSeconds = 0;
  audio.dataset.pendingSeek = '0';
  if (current) {
    writeLocal(current.id, 0);
    syncServer(current.id, 0);
  }
  resumeNote.textContent = '';
});
audio.addEventListener('error', () => {
  if (!current || !audio.getAttribute('src')) return;
  playerError.textContent = '这个文件播不了';
});

window.addEventListener('pagehide', flushPosition);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPosition();
});

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => audio.play().catch(() => { playerError.textContent = '无法播放'; }),
    pause: () => audio.pause(),
    seekbackward: (details) => seekTo(audio.currentTime - (details.seekOffset || 15)),
    seekforward: (details) => seekTo(audio.currentTime + (details.seekOffset || 15)),
    seekto: (details) => seekTo(details.seekTime),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* Older browsers. */ }
  }
}

loadEpisodes().then(() => {
  const lastId = localStorage.getItem(CURRENT_KEY);
  const last = episodes.find((item) => item.id === lastId);
  if (last) return openEpisode(last);
  return null;
}).catch(() => {
  listErrorEl.textContent = '列表加载失败，请刷新。';
});
