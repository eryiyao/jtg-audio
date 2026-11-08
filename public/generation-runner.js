'use strict';
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.JtgGenerationRunner = value;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  class GenerationRunner {
    constructor({ api, generate, getKey, onProject, onStatus, onFinish, onPending }) {
      Object.assign(this, { api, generate, getKey, onProject, onStatus, onFinish, onPending });
      this.running = false; this.pending = null;
    }
    requestPause() { this.pauseRequested = true; this.wake?.(); this.onStatus('正在暂停：本段生成并保存后停止，已有音频保留。'); }
    async wait(ms) {
      await new Promise(resolve => { const timer = setTimeout(resolve, ms); this.wake = () => { clearTimeout(timer); resolve(); }; });
      this.wake = null;
    }
    async upload(p, index, blob, headers) {
      const form = new FormData(); form.append('audio', blob, `gemini-${index}.wav`);
      return this.api(`/api/studio/projects/${p.id}/segments/${index}/audio`, 'POST', form,
        { 'X-JTG-Revision': String(p.revision), ...headers });
    }
    async run(project, options) {
      if (this.running || this.pending) throw new Error('请先完成当前生成或保存待处理音频');
      const apiKey = this.getKey(); if (!apiKey) throw new Error('请先连接 Gemini 免费项目');
      this.running = true; this.pauseRequested = false; this.lost = false;
      const base = `/api/studio/projects/${project.id}`;
      const runId = crypto.randomUUID(), token = crypto.randomUUID();
      const headers = { 'X-JTG-Generation': token };
      const controller = new AbortController();
      let p = project, heartbeat, heartbeating = false, started = false;
      try {
        p = await this.api(base + '/generation', 'POST', { ...options, runId, token, revision: project.revision });
        started = true; this.onProject(p);
        heartbeat = setInterval(async () => {
          if (heartbeating) return;
          heartbeating = true;
          try { await this.api(base + '/generation/heartbeat', 'POST', {}, headers); }
          catch { this.lost = true; controller.abort(); this.wake?.(); }
          finally { heartbeating = false; }
        }, 20000);
        while (!this.pauseRequested && !this.lost) {
          const step = await this.api(base + '/generation/next', 'POST', {}, headers);
          p = step.project; this.onProject(p);
          if (step.done) { this.onStatus('待生成分段已全部保存。现在可以试听核对，再合并入库。'); return; }
          if (step.waitMs) { this.onStatus(`按免费额度节奏等待约 ${Math.ceil(step.waitMs / 1000)} 秒，之后继续下一段。请保持页面打开。`); await this.wait(step.waitMs); continue; }
          if (step.model !== 'gemini-3.8-flash-tts') throw Object.assign(new Error('生成模型不匹配，请刷新后再试'), { reason: 'access' });
          const s = p.segments.find(item => item.index === step.index);
          this.onStatus(`正在生成第 ${s.index} / ${p.total} 段，完成后会自动保存。请保持页面打开。`);
          const blob = await this.generate({ apiKey, text: s.text, voice: p.voice, style: p.style, signal: controller.signal });
          this.pending = { projectId: p.id, index: s.index, blob, runId, originalAudioUrl: s.audioUrl };
          this.onStatus(`第 ${s.index} 段已生成，正在自动保存并检查…`);
          let saved = false, lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { p = await this.upload(p, s.index, blob, headers); saved = true; break; }
            catch (e) {
              lastError = e;
              // An acknowledgement can be lost after a successful save. Check
              // the same run's receipt before retrying the upload, never the TTS.
              try {
                const latest = await this.api(base);
                if (latest.generation?.runId === runId && latest.generation.lastSavedIndex === s.index && latest.segments.find(item => item.index === s.index)?.audioUrl) { p = latest; saved = true; break; }
                p = latest;
              } catch {}
              if (e.status && e.status < 500 && e.status !== 409) break;
              if (this.lost) break;
              await this.wait(2000);
            }
          }
          if (!saved) throw Object.assign(new Error(lastError?.message || '本段保存未完成'), { reason: 'audio' });
          this.pending = null; this.onProject(p);
        }
        p = await this.api(base + '/generation/pause', 'POST', { reason: this.lost ? 'connection' : 'stopped' }, headers);
        this.onProject(p); this.onStatus(this.lost ? '连接已中断，已保存的分段保留。' : '已暂停，之后可以接着生成。');
      } catch (e) {
        if (started) {
          try { this.onProject(await this.api(base + '/generation/pause', 'POST', { reason: e.reason || 'connection' }, headers)); } catch {}
        }
        if (this.pending) this.onPending(this.pending);
        this.onStatus(this.pending ? '本段声音已生成，但尚未保存到云端。请重试保存，或下载这段备份；暂时不要关闭本页。' : e.message);
      } finally {
        clearInterval(heartbeat); this.wake?.(); this.running = false; this.onFinish();
      }
    }
    async retrySave() {
      if (!this.pending || this.running) return;
      const item = this.pending;
      const p = await this.api(`/api/studio/projects/${item.projectId}`);
      const current = p.segments.find(s => s.index === item.index);
      if (p.generation?.runId === item.runId && p.generation.lastSavedIndex === item.index && current?.audioUrl) {
        this.pending = null; this.onProject(p); this.onPending(null); this.onStatus('本段已经保存在云端，可以继续生成。'); return;
      }
      if (!current || current.audioUrl !== item.originalAudioUrl) throw new Error('这一段的云端音频已被其他操作更新。请下载本段备份并核对，不能直接覆盖新的音频。');
      const saved = await this.upload(p, item.index, item.blob, {});
      this.pending = null; this.onProject(saved); this.onPending(null); this.onStatus('本段已保存，可以继续生成。');
    }
  }
  return GenerationRunner;
});
