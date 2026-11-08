'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const DRAFT_KEY = 'jtg-studio-unsaved-v1';
  let config, project, projects = [], selected = 1, busy = false, poll, generation = 0;
  let draftId = crypto.randomUUID();
  const count = text => Array.from(text).length;
  const duration = n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  const editable = () => project && project.status !== 'merging' && !(project.status === 'complete' && project.episodeId);
  const segment = () => project?.segments.find(s => s.index === selected);
  const url = suffix => `/api/studio/projects/${project.id}${suffix || ''}`;
  function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
  async function api(path, method = 'GET', body, headers = {}) {
    const form = body instanceof FormData;
    const response = await JtgSession.request(path, { method, headers: { ...(!form && body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || '操作未完成，请重试'), { status: response.status });
    return result;
  }
  function setBusy(value) {
    busy = value;
    for (const id of ['new-project', 'project-select', 'refresh-project', 'delete-project', 'copy-style', 'copy-text', 'pick-segment', 'reviewed', 'merge-project', 'previous-segment', 'next-segment']) $(id).disabled = value;
    document.querySelectorAll('#segment-list button').forEach(b => { b.disabled = value; });
    if (!value && project) applyDisabled();
  }
  function applyDisabled() {
    const writable = editable();
    $('pick-segment').disabled = !writable || !config.mediaReady;
    $('reviewed').disabled = !writable || !segment()?.audioUrl;
    $('merge-project').disabled = !writable || !config.mediaReady || project.reviewed !== project.total;
    $('delete-project').disabled = project.status === 'merging';
    $('previous-segment').disabled = selected === 1;
    $('next-segment').disabled = selected === project.total;
  }
  async function action(fn) {
    if (busy) return;
    setBusy(true); notice();
    try { await fn(); }
    catch (e) {
      notice(e.message);
      if (e.status === 409 && project) {
        try { project = await api(url()); render(); } catch { /* retain the last known progress */ }
      }
    } finally { setBusy(false); }
  }
  function setAudio(el, source) {
    if (el.getAttribute('src') === source) return;
    el.pause();
    if (source) el.setAttribute('src', source); else el.removeAttribute('src');
    el.load();
  }
  function renderPicker() {
    const picker = $('project-select'); picker.replaceChildren();
    if (!projects.length) picker.add(new Option('还没有制作任务', ''));
    for (const p of projects) picker.add(new Option(`${p.title} · ${p.status === 'complete' && p.episodeId ? '已入库' : `${p.reviewed}/${p.total} 段已核对`}`, p.id));
    if (project) picker.value = project.id;
  }
  function accept(next) {
    project = next;
    const index = projects.findIndex(p => p.id === next.id);
    if (index < 0) projects.unshift(next); else projects[index] = next;
    renderPicker(); render();
  }
  function render() {
    $('studio-empty').hidden = !!project; $('workspace').hidden = !project;
    clearTimeout(poll);
    if (!project) return;
    selected = Math.max(1, Math.min(selected, project.total));
    const s = segment();
    $('project-title').textContent = project.title;
    $('project-progress').textContent = `${project.total} 段 · ${project.uploaded} 段已上传 · ${project.reviewed} 段已核对 · 草稿音频 ${(project.sizeBytes / 1024 ** 2).toFixed(1)} MB`;
    $('project-bar').max = project.total; $('project-bar').value = project.reviewed;
    const complete = project.status === 'complete' && project.episodeId;
    $('merge-project').hidden = !!complete; $('open-result').hidden = !complete;
    $('merge-project').textContent = project.status === 'merging' ? '正在合并…' : '合并并加入音频库';
    $('merge-state').textContent = project.status === 'merging' ? '正在按顺序合并、调整整体音量，可以关闭页面，稍后回来查看。'
      : complete ? '已加入音频库。制作草稿暂时保留；删除草稿可释放空间，已入库音频仍会保留。'
        : project.error || '逐段试听确认后即可合并。文件检查无法自动判断漏读、错字或声音是否一致。';
    $('segment-count').textContent = `${project.total} 段`;
    const list = $('segment-list'); list.replaceChildren();
    for (const item of project.segments) {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.setAttribute('aria-current', String(item.index === selected));
      const number = document.createElement('span'); number.className = 'segment-number'; number.textContent = String(item.index).padStart(2, '0');
      const copy = document.createElement('span'); copy.className = 'segment-item-copy';
      const title = document.createElement('strong'); title.textContent = item.text.trim().slice(0, 35);
      const state = document.createElement('small'); state.textContent = item.reviewed ? '✓ 已核对' : item.audioUrl ? '待试听核对' : item.copied ? '已复制 · 待上传' : '待生成';
      copy.append(title, state); button.append(number, copy); li.append(button); list.append(li);
      button.disabled = busy;
      button.addEventListener('click', () => { if (!busy) { selected = item.index; render(); } });
    }
    $('segment-title').textContent = `第 ${s.index} 段 / ${project.total} 段`;
    $('segment-status').textContent = `${count(s.text)} 字 · ${s.reviewed ? '已核对' : s.audioUrl ? '待试听核对' : s.copied ? '已复制正文' : '待生成'}`;
    $('voice-name').textContent = project.voice; $('style-text').textContent = project.style;
    $('segment-text').value = s.text;
    $('pick-segment').textContent = s.audioUrl ? '重新上传本段' : '上传本段音频';
    $('upload-help').textContent = config.mediaReady ? `支持常见音频格式，每段最多 ${config.maxUploadMb} MB、20 分钟。重新上传会取消本段的试听确认。` : '服务器暂时不能检查或合并音频，文字与进度仍可保存。';
    $('audio-review').hidden = !s.audioUrl;
    setAudio($('segment-audio'), s.audioUrl);
    $('check-result').textContent = s.audioUrl ? `✓ 文件可完整解码 · ${duration(s.durationSeconds)} · ${s.warnings.length ? '有项目需要留意' : '未发现长静音或明显时长异常'}` : '';
    $('audio-warnings').replaceChildren(...s.warnings.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
    $('reviewed').checked = s.reviewed;
    const previous = project.segments.find(item => item.index === selected - 1);
    $('comparison').hidden = !previous?.audioUrl;
    setAudio($('comparison-audio'), previous?.audioUrl || null);
    $('save-note').textContent = `云端已保存 · ${new Date(project.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 可以关闭页面后继续`;
    if (!busy) applyDisabled();
    if (project.status === 'merging') schedulePoll();
  }
  function schedulePoll() {
    const id = project.id;
    poll = setTimeout(async () => {
      if (!project || project.id !== id) return;
      if (busy) return schedulePoll();
      try { const next = await api(`/api/studio/projects/${id}`); if (project?.id === id) accept(next); }
      catch (e) { notice(`${e.message}。任务保留在云端，可刷新进度。`); }
    }, 2500);
  }
  async function load(id) {
    const token = ++generation;
    const next = id ? await api(`/api/studio/projects/${id}`) : null;
    if (token !== generation) return;
    project = next;
    selected = next?.segments.find(s => !s.reviewed)?.index || 1;
    history.replaceState(null, '', id ? `#${id}` : location.pathname);
    renderPicker(); render();
  }
  async function refresh() {
    projects = await api('/api/studio/projects');
    const id = project?.id || location.hash.slice(1);
    await load(projects.some(p => p.id === id) ? id : projects[0]?.id);
  }
  async function copy(text, input) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      if (input) { input.focus(); input.select(); }
      throw new Error(input ? '浏览器未允许自动复制，正文已选中，请手动复制。' : '浏览器未允许自动复制，请展开朗读要求后手动复制。');
    }
  }
  $('copy-text').addEventListener('click', () => action(async () => {
    const s = segment(); await copy(s.text, $('segment-text'));
    if (editable() && !s.copied) accept(await api(url(`/segments/${selected}`), 'PATCH', { revision: project.revision, copied: true }));
    notice(`第 ${selected} 段正文已复制。Gemini 中固定选择 ${project.voice}，并沿用同一份朗读要求。`);
  }));
  $('copy-style').addEventListener('click', () => action(async () => { await copy(project.style); notice('朗读要求已复制，请粘贴到 Gemini 的 Style 输入框。'); }));
  $('previous-segment').addEventListener('click', () => { selected--; render(); });
  $('next-segment').addEventListener('click', () => { selected++; render(); });
  $('refresh-project').addEventListener('click', () => action(refresh));
  $('project-select').addEventListener('change', event => action(() => load(event.target.value)));
  $('pick-segment').addEventListener('click', () => $('segment-file').click());
  $('segment-file').addEventListener('change', () => {
    const file = $('segment-file').files[0]; $('segment-file').value = '';
    if (!file) return;
    if (file.size > config.maxUploadMb * 1024 ** 2) return notice(`每段音频最多 ${config.maxUploadMb} MB。`);
    if (segment().audioUrl && !confirm(`替换第 ${selected} 段音频？检查通过后会替换旧文件，并需要重新试听核对。`)) return;
    action(async () => {
      notice(`正在上传并检查第 ${selected} 段，请暂时保持页面打开…`);
      const form = new FormData(); form.append('audio', file);
      accept(await api(url(`/segments/${selected}/audio`), 'POST', form, { 'X-JTG-Revision': String(project.revision) }));
      notice('文件已保存并完成检查，请试听核对正文和声音。');
    });
  });
  $('reviewed').addEventListener('change', () => action(async () => {
    const checked = $('reviewed').checked;
    try { accept(await api(url(`/segments/${selected}`), 'PATCH', { revision: project.revision, reviewed: checked })); }
    catch (e) { $('reviewed').checked = segment().reviewed; throw e; }
  }));
  $('segment-audio').addEventListener('play', () => $('comparison-audio').pause());
  $('comparison-audio').addEventListener('play', () => $('segment-audio').pause());
  $('listen-previous').addEventListener('click', async () => {
    const audio = $('comparison-audio');
    try {
      if (audio.readyState < 1) await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('上一段暂时无法播放，请刷新后再试')); };
        const timer = setTimeout(failed, 15000);
        audio.addEventListener('loadedmetadata', loaded); audio.addEventListener('error', failed); audio.load();
      });
      audio.currentTime = Math.max(0, audio.duration - 15); await audio.play();
    } catch (e) { notice(e.message); }
  });
  $('merge-project').addEventListener('click', () => action(async () => {
    $('segment-audio').pause(); $('comparison-audio').pause();
    accept(await api(url('/merge'), 'POST', { revision: project.revision }));
  }));
  $('delete-project').addEventListener('click', () => {
    if (!confirm(`删除“${project.title}”的制作草稿和全部分段文件？已入库的音频会保留。此操作无法撤销。`)) return;
    action(async () => { await api(url(), 'DELETE', { revision: project.revision }); project = null; history.replaceState(null, '', location.pathname); await refresh(); notice('制作草稿已删除，已入库音频保留。'); });
  });
  $('download-text').addEventListener('click', () => {
    const s = segment(), href = URL.createObjectURL(new Blob([s.text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = href; a.download = `${project.title.replace(/[\\/:*?"<>|]/g, '_')}_${String(selected).padStart(3, '0')}.txt`;
    a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  });
  function draft() { return { id: draftId, title: $('draft-title').value, text: $('draft-text').value,
    target: Number($('draft-target').value), voice: $('draft-voice').value, style: $('draft-style').value }; }
  function saveLocalDraft() {
    $('preview-result').hidden = true;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft())); $('draft-status').textContent = '输入已暂存本机；分段保存后，可跨设备继续。'; }
    catch { $('draft-status').textContent = '本机暂存不可用，请及时分段并保存任务。'; }
  }
  $('new-project').addEventListener('click', () => { $('draft-status').classList.remove('error'); $('new-dialog').showModal(); });
  $('close-new').addEventListener('click', () => $('new-dialog').close());
  $('new-form').addEventListener('input', saveLocalDraft);
  $('preview-draft').addEventListener('click', async () => {
    $('preview-draft').disabled = true;
    try {
      const data = await api('/api/studio/preview', 'POST', draft());
      const p = document.createElement('p'); p.textContent = `${data.characterCount.toLocaleString()} 字 → ${data.segments.length} 段，正文完整保留。`;
      const ol = document.createElement('ol');
      data.segments.forEach(text => { const li = document.createElement('li'); li.textContent = `${count(text)} 字 · ${text.trim().slice(0, 42)}…`; ol.append(li); });
      $('preview-result').replaceChildren(p, ol); $('preview-result').hidden = false;
      $('draft-status').classList.remove('error');
    } catch (e) { $('draft-status').textContent = e.message; $('draft-status').classList.add('error'); }
    finally { $('preview-draft').disabled = false; }
  });
  $('new-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); $('create-project').disabled = true; $('close-new').disabled = true;
    // Freeze the submitted manuscript while awaiting its cloud acknowledgement.
    const body = draft(); const controls = [...$('new-form').querySelectorAll('input,textarea,select,button')];
    controls.forEach(el => { el.disabled = true; });
    try {
      const next = await api('/api/studio/projects', 'POST', body);
      selected = 1; accept(next); history.replaceState(null, '', `#${next.id}`);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* not required for cloud progress */ }
      $('new-form').reset(); $('draft-style').value = config.defaultStyle; draftId = crypto.randomUUID();
      $('preview-result').hidden = true; $('new-dialog').close(); notice('任务已保存。先复制朗读要求，再逐段生成和上传。');
    } catch (e) { $('draft-status').textContent = e.message; $('draft-status').classList.add('error'); }
    finally { controls.forEach(el => { el.disabled = false; }); $('close-new').disabled = false; setBusy(false); }
  });
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('jtg:session-expired', () => { $('segment-audio').pause(); $('comparison-audio').pause(); });
  async function init() {
    setBusy(true);
    try {
      config = await api('/api/studio/config'); $('draft-style').value = config.defaultStyle;
      try {
        const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
        if (saved) {
          if (typeof saved.id === 'string') draftId = saved.id;
          for (const key of ['title', 'text', 'target', 'voice', 'style']) if (saved[key] != null) $(`draft-${key}`).value = saved[key];
        }
      } catch { /* fresh draft */ }
      await refresh();
      if (!config.mediaReady) notice('文字与进度可以保存；服务器尚未准备好音频检查与合并功能。');
    } catch (e) { notice(e.message); }
    finally { setBusy(false); }
  }
  init();
})();
