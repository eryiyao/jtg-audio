'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { splitText, DEFAULT_STYLE } = require('./studio-text');
const media = require('./studio-media');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.mp4', '.ogg', '.opus', '.aac', '.flac', '.webm']);
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });

function createStudio(store, config, { streamFile }) {
  const db = store.db;
  const root = path.join(config.dataDir, 'studio');
  const ready = media.available();
  const router = express.Router();
  const locks = new Set();
  let processing = false;
  let job = null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
      voice TEXT NOT NULL, style TEXT NOT NULL, target INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      error TEXT, episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      pending_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_segments (
      project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, copied INTEGER NOT NULL DEFAULT 0,
      audio_name TEXT, duration REAL, size_bytes INTEGER, hash TEXT, warnings TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, ordinal)
    );
  `);
  const get = id => db.prepare('SELECT * FROM studio_projects WHERE id = ?').get(id);
  const segments = id => db.prepare('SELECT * FROM studio_segments WHERE project_id = ? ORDER BY ordinal').all(id);
  const directory = id => path.join(root, id);
  const touch = id => db.prepare('UPDATE studio_projects SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), id);
  const remove = file => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  function ensureSpace(location, bytes) {
    const disk = fs.statfsSync(location);
    if (disk.bavail * disk.bsize < bytes) throw fail(507, '服务器剩余空间不足，请先删除不需要的制作草稿或音频');
  }

  // A process restart never declares an interrupted merge successful. Retain all
  // accepted segments, remove only our own incomplete/orphaned working files.
  for (const p of db.prepare('SELECT * FROM studio_projects').all()) {
    if (p.pending_name && /^studio-[\da-f-]+\.mp3$/.test(p.pending_name)) {
      try {
        remove(path.join(config.uploadDir, p.pending_name));
        db.prepare('UPDATE studio_projects SET pending_name = NULL WHERE id = ?').run(p.id);
      } catch { console.error('Studio: partial merge cleanup deferred'); }
    }
    if (p.status === 'merging') {
      db.prepare("UPDATE studio_projects SET status = 'error', error = ?, revision = revision + 1 WHERE id = ?")
        .run('上次合并因服务重启中断，分段已保留，可以重新合并。', p.id);
    }
    if (fs.existsSync(directory(p.id))) {
      const kept = new Set(segments(p.id).map(s => s.audio_name).filter(Boolean));
      try {
        for (const name of fs.readdirSync(directory(p.id))) if (!kept.has(name)) remove(path.join(directory(p.id), name));
      } catch { console.error('Studio: working-file cleanup deferred'); }
    }
  }

  function view(p, detail = true) {
    const all = segments(p.id);
    const result = { id: p.id, title: p.title, voice: p.voice, style: p.style, target: p.target,
      revision: p.revision, status: p.status, error: p.error, episodeId: p.episode_id,
      createdAt: p.created_at, updatedAt: p.updated_at, total: all.length,
      uploaded: all.filter(s => s.audio_name).length, reviewed: all.filter(s => s.reviewed).length,
      sizeBytes: all.reduce((sum, s) => sum + (s.size_bytes || 0), 0) };
    if (detail) result.segments = all.map(s => ({ index: s.ordinal, text: s.text, copied: !!s.copied,
      reviewed: !!s.reviewed, durationSeconds: s.duration, sizeBytes: s.size_bytes,
      warnings: JSON.parse(s.warnings || '[]'),
      audioUrl: s.audio_name ? `/api/studio/projects/${p.id}/segments/${s.ordinal}/audio?v=${s.audio_name}` : null }));
    return result;
  }
  function project(req) {
    if (!ID.test(req.params.id)) throw fail(404, '找不到这个制作任务');
    const p = get(req.params.id);
    if (!p) throw fail(404, '找不到这个制作任务');
    return p;
  }
  function writable(req, p) {
    const revision = req.is('multipart/form-data') ? Number(req.get('X-JTG-Revision')) : req.body?.revision;
    if (revision !== p.revision) throw fail(409, '进度已在其他页面更新，请重新载入后继续');
    if (locks.has(p.id) || p.status === 'merging') throw fail(409, '这个任务正在处理音频，请稍后再试');
    if (p.status === 'complete' && p.episode_id) throw fail(409, '这个任务已入库；如需改稿或更换声音，请新建任务');
  }
  function segment(req, p) {
    if (!/^\d{1,3}$/.test(req.params.index)) throw fail(404, '找不到这个分段');
    const s = db.prepare('SELECT * FROM studio_segments WHERE project_id = ? AND ordinal = ?').get(p.id, Number(req.params.index));
    if (!s) throw fail(404, '找不到这个分段');
    return s;
  }
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  router.get('/config', (req, res) => res.json({ mediaReady: ready, defaultStyle: DEFAULT_STYLE,
    maxCharacters: 100000, maxUploadMb: Math.min(config.maxUploadMb, 100), maxSegmentMinutes: 20,
    geminiUrl: 'https://aistudio.google.com/generate-speech' }));
  router.get('/projects', route((req, res) => {
    res.json(db.prepare('SELECT * FROM studio_projects ORDER BY updated_at DESC, id').all().map(p => view(p, false)));
  }));
  router.post('/preview', route((req, res) => {
    try { res.json(splitText(req.body?.text, req.body?.target ?? 1000)); }
    catch (e) { throw fail(400, e.message); }
  }));
  router.post('/projects', route((req, res) => {
    const body = req.body || {};
    if (!ID.test(body.id || '')) throw fail(400, '请重新打开新建窗口后重试');
    let split;
    try { split = splitText(body.text, body.target ?? 1000); } catch (e) { throw fail(400, e.message); }
    const title = typeof body.title === 'string' ? body.title.replace(/[\u0000-\u001f]/g, '').trim() : '';
    const voice = typeof body.voice === 'string' ? body.voice.trim() : 'Charon';
    const style = typeof body.style === 'string' ? body.style.trim() : DEFAULT_STYLE;
    if (!title || title.length > 120 || !voice || voice.length > 64 || !style || style.length > 2000) throw fail(400, '请填写标题、声音和朗读要求，并检查长度');
    const existing = get(body.id);
    if (existing) {
      if (existing.source !== split.text || existing.title !== title || existing.voice !== voice || existing.style !== style || existing.target !== (body.target ?? 1000)) throw fail(409, '这个草稿已保存，请重新载入');
      return res.json(view(existing));
    }
    if (db.prepare('SELECT count(*) AS n FROM studio_projects').get().n >= 50) throw fail(409, '最多保留 50 个制作任务，请先删除已完成任务的草稿');
    transaction(() => {
      db.prepare('INSERT INTO studio_projects (id,title,source,voice,style,target,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(body.id, title, split.text, voice, style, body.target ?? 1000, now(), now());
      const insert = db.prepare('INSERT INTO studio_segments (project_id,ordinal,text) VALUES (?,?,?)');
      split.segments.forEach((text, i) => insert.run(body.id, i + 1, text));
    });
    res.status(201).json(view(get(body.id)));
  }));
  router.get('/projects/:id', route((req, res) => res.json(view(project(req)))));
  router.delete('/projects/:id', route((req, res) => {
    const p = project(req);
    if (req.body?.revision !== p.revision || locks.has(p.id) || p.status === 'merging') throw fail(409, '任务已更新或正在处理，请重新载入后再删除');
    // Remove real draft files first. On failure retain the record and report it.
    fs.rmSync(directory(p.id), { recursive: true, force: true });
    db.prepare('DELETE FROM studio_projects WHERE id = ?').run(p.id);
    res.status(204).end();
  }));
  router.patch('/projects/:id/segments/:index', route((req, res) => {
    const p = project(req); writable(req, p); const s = segment(req, p);
    if (typeof req.body.reviewed === 'boolean') {
      if (req.body.reviewed && !s.audio_name) throw fail(400, '请先上传并检查这一段音频');
      db.prepare('UPDATE studio_segments SET reviewed = ? WHERE project_id = ? AND ordinal = ?').run(req.body.reviewed ? 1 : 0, p.id, s.ordinal);
    } else if (req.body.copied === true) {
      db.prepare('UPDATE studio_segments SET copied = 1 WHERE project_id = ? AND ordinal = ?').run(p.id, s.ordinal);
    } else throw fail(400, '进度参数无效');
    touch(p.id); res.json(view(get(p.id)));
  }));
  router.get('/projects/:id/segments/:index/audio', route((req, res) => {
    const p = project(req), s = segment(req, p);
    if (!s.audio_name) throw fail(404, '这一段还没有音频');
    streamFile(req, res, path.join(directory(p.id), s.audio_name), 'audio/wav');
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) { cb(null, directory(req.params.id)); },
      filename(req, file, cb) { cb(null, `${crypto.randomUUID()}.input`); },
    }),
    limits: { fileSize: Math.round(Math.min(config.maxUploadMb, 100) * 1024 * 1024), files: 1, fields: 0 },
    fileFilter(req, file, cb) {
      cb(EXTENSIONS.has(path.extname(file.originalname).toLowerCase()) ? null : fail(400, '请选择 WAV、MP3、M4A 等音频文件'), true);
    },
  }).single('audio');

  router.post('/projects/:id/segments/:index/audio', route(async (req, res) => {
    const p = project(req); writable(req, p); const s = segment(req, p);
    if (!ready) throw fail(503, '音频处理组件尚未准备好，文字和进度仍可保存');
    if (processing) throw fail(409, '正在处理另一段音频，请稍后再上传');
    ensureSpace(config.dataDir, 512 * 1024 ** 2);
    processing = true; locks.add(p.id);
    let output;
    try {
      fs.mkdirSync(directory(p.id), { recursive: true });
      await new Promise((resolve, reject) => upload(req, res, e => e ? reject(e) : resolve()));
      if (!req.file?.size) throw fail(400, '请选择非空的音频文件');
      const name = `${crypto.randomUUID()}.wav`; output = path.join(directory(p.id), name);
      let checked;
      try { checked = await media.checkAudio(req.file.path, output, s.text); } catch (e) { throw fail(422, e.message); }
      const duplicate = db.prepare('SELECT ordinal FROM studio_segments WHERE project_id = ? AND hash = ? AND ordinal != ?').get(p.id, checked.hash, s.ordinal);
      if (duplicate) throw fail(409, `这个音频与第 ${duplicate.ordinal} 段相同，请检查是否选错文件`);
      const used = db.prepare('SELECT coalesce(sum(size_bytes), 0) AS n FROM studio_segments WHERE project_id = ?').get(p.id).n;
      if (used - (s.size_bytes || 0) + checked.sizeBytes > 1024 ** 3) throw fail(413, '本任务的分段音频超过 1 GB，请拆成多个任务');
      transaction(() => {
        db.prepare('UPDATE studio_segments SET audio_name=?, duration=?, size_bytes=?, hash=?, warnings=?, reviewed=0 WHERE project_id=? AND ordinal=?')
          .run(name, checked.durationSeconds, checked.sizeBytes, checked.hash, JSON.stringify(checked.warnings), p.id, s.ordinal);
        db.prepare("UPDATE studio_projects SET status='draft', error=NULL WHERE id=?").run(p.id);
        touch(p.id);
      });
      output = null;
      if (s.audio_name) {
        try { remove(path.join(directory(p.id), s.audio_name)); }
        catch { console.error('Studio: obsolete segment retained for startup cleanup'); }
      }
      res.json(view(get(p.id)));
    } finally {
      for (const file of [req.file?.path, output].filter(Boolean)) {
        try { remove(file); } catch { console.error('Studio: temporary file cleanup failed'); }
      }
      processing = false; locks.delete(p.id);
    }
  }));

  async function merge(p, all, pendingName) {
    const output = path.join(config.uploadDir, pendingName);
    const manifest = path.join(directory(p.id), 'merge.txt');
    try {
      for (const s of all) if (!fs.existsSync(path.join(directory(p.id), s.audio_name))) throw new Error('有分段文件缺失，请重新上传后再合并');
      fs.writeFileSync(manifest, all.map(s => `file '${s.audio_name}'`).join('\n') + '\n');
      const result = await media.mergeAudio(manifest, output);
      const expected = all.reduce((sum, s) => sum + s.duration, 0);
      if (Math.abs(expected - result.durationSeconds) > Math.max(2, expected * 0.005)) throw new Error('合并时长不符合预期，请重试');
      const episodeId = crypto.randomUUID();
      transaction(() => {
        store.insertEpisode.run(episodeId, p.title, pendingName, `${p.title}.mp3`, 'audio/mpeg', result.sizeBytes, now());
        store.setDuration.run(result.durationSeconds, episodeId);
        db.prepare("UPDATE studio_projects SET status='complete', error=NULL, episode_id=?, pending_name=NULL WHERE id=?").run(episodeId, p.id);
        touch(p.id);
      });
    } catch (err) {
      try { remove(output); } catch { console.error('Studio: partial merge cleanup failed'); }
      db.prepare("UPDATE studio_projects SET status='error', error=?, revision=revision+1, updated_at=? WHERE id=?")
        .run(err.cmd ? '合并没有完成，请稍后重试。所有分段均已保留。' : err.message, now(), p.id);
    } finally {
      try { remove(manifest); } catch { console.error('Studio: manifest cleanup failed'); }
      processing = false; locks.delete(p.id); job = null;
    }
  }
  router.post('/projects/:id/merge', route((req, res) => {
    const p = project(req);
    // Retried requests return the same job/result, never a duplicate episode.
    if (p.status === 'merging' || (p.status === 'complete' && p.episode_id)) return res.status(p.status === 'merging' ? 202 : 200).json(view(p));
    writable(req, p);
    if (!ready) throw fail(503, '音频处理组件尚未准备好');
    if (processing) throw fail(409, '正在处理另一段音频，请稍后合并');
    const all = segments(p.id);
    if (all.some(s => !s.audio_name || !s.reviewed)) throw fail(409, '请先上传每一段音频，并逐段试听核对');
    ensureSpace(config.uploadDir, all.reduce((sum, s) => sum + s.size_bytes, 0) * 0.3 + 256 * 1024 ** 2);
    const pendingName = `studio-${crypto.randomUUID()}.mp3`;
    db.prepare("UPDATE studio_projects SET status='merging', error=NULL, pending_name=? WHERE id=?").run(pendingName, p.id);
    touch(p.id); processing = true; locks.add(p.id);
    res.status(202).json(view(get(p.id)));
    job = merge(p, all, pendingName);
  }));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) return res.status(413).json({ error: `请选择一个不超过 ${Math.min(config.maxUploadMb, 100)} MB 的音频文件` });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Studio operation failed:', err.code || err.name);
    res.status(500).json({ error: '操作未完成，请重新载入后重试' });
  });
  return { router, waitForIdle: async () => { if (job) await job; } };
}

module.exports = { createStudio };
