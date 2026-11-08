'use strict';
const crypto = require('node:crypto');
const MODEL = 'gemini-3.8-flash-tts';
const LEASE_MS = 90000;
const INTERVAL_MS = 65000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 20; // App safety ceiling, not a claim about Google's quota.
const TOKEN_RE = /^[0-9a-f-]{36}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = token => crypto.createHash('sha256').update(token).digest('hex');

function createGeneration(db, clock = Date.now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_generation (
      project_id TEXT PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, token_hash TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL, remaining TEXT NOT NULL, current_index INTEGER,
      last_saved_index INTEGER, lease_until INTEGER NOT NULL, next_at INTEGER,
      message TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_generation_attempts (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL
    );
  `);
  db.prepare("UPDATE studio_generation SET status='paused', current_index=NULL, lease_until=0, message=? WHERE status='running'")
    .run('服务已重启。已保存的分段保留，请重新点击继续生成。');
  function row(id) {
    const r = db.prepare('SELECT * FROM studio_generation WHERE project_id=?').get(id);
    if (r?.status === 'running' && r.lease_until <= clock()) {
      pause(id, '生成页面已断开，已保存的分段保留，可以继续生成。');
      return db.prepare('SELECT * FROM studio_generation WHERE project_id=?').get(id);
    }
    return r;
  }
  function state(id) {
    const r = row(id);
    return r ? { runId: r.run_id, model: r.model, status: r.status, currentIndex: r.current_index,
      lastSavedIndex: r.last_saved_index, remaining: JSON.parse(r.remaining).length,
      nextAt: r.next_at, message: r.message, leaseUntil: r.lease_until } : null;
  }
  function active(id) { return row(id)?.status === 'running'; }
  function owner(id, token) {
    const r = row(id);
    if (!TOKEN_RE.test(token || '') || r?.status !== 'running' || r.token_hash !== digest(token)) throw fail(409, '这次生成已暂停或被其他页面接手，请重新载入进度');
    return r;
  }
  function start(p, all, body) {
    if (!TOKEN_RE.test(body.token || '') || !TOKEN_RE.test(body.runId || '')) throw fail(400, '生成参数无效，请重试');
    const existing = row(p.id);
    if (existing?.run_id === body.runId && existing.token_hash === digest(body.token)) return state(p.id);
    if (body.revision !== p.revision) throw fail(409, '进度已更新，请重新载入后继续');
    if (active(p.id)) throw fail(409, '这个任务正在另一个页面生成，请先停止或等待完成');
    const other = db.prepare("SELECT project_id FROM studio_generation WHERE status='running' AND lease_until > ?").get(clock());
    if (other) throw fail(409, '已有一个任务在生成，请先完成或暂停它');
    if (p.status === 'merging' || (p.status === 'complete' && p.episode_id)) throw fail(409, '这个任务正在合并或已经入库');
    if (!['Charon', 'Orus', 'Algenib'].includes(p.voice)) throw fail(400, '自动生成目前支持 Charon、Orus 和 Algenib，请用这些声音新建任务');
    const remaining = body.mode === 'single'
      ? all.filter(s => s.ordinal === body.index).map(s => s.ordinal)
      : body.mode === 'missing' ? all.filter(s => !s.audio_name).map(s => s.ordinal) : [];
    if (!remaining.length) throw fail(400, '没有需要生成的分段');
    if (body.mode === 'single' && all.find(s => s.ordinal === body.index)?.audio_name && body.replace !== true) throw fail(400, '重做已有音频需要确认替换');
    db.prepare(`INSERT INTO studio_generation (project_id,run_id,token_hash,model,status,remaining,lease_until,updated_at)
      VALUES (?,?,?,?,'running',?,?,?) ON CONFLICT(project_id) DO UPDATE SET run_id=excluded.run_id,
      token_hash=excluded.token_hash,model=excluded.model,status='running',remaining=excluded.remaining,
      current_index=NULL,last_saved_index=NULL,lease_until=excluded.lease_until,next_at=NULL,message=NULL,updated_at=excluded.updated_at`)
      .run(p.id, body.runId, digest(body.token), MODEL, JSON.stringify(remaining), clock() + LEASE_MS, clock());
    return state(p.id);
  }
  function heartbeat(id, token) {
    owner(id, token);
    db.prepare('UPDATE studio_generation SET lease_until=?,updated_at=? WHERE project_id=?').run(clock() + LEASE_MS, clock(), id);
    return state(id);
  }
  function next(id, token) {
    const r = owner(id, token);
    if (r.current_index != null) throw fail(409, '当前分段尚未保存，不能重复请求生成');
    const remaining = JSON.parse(r.remaining);
    if (!remaining.length) {
      db.prepare("UPDATE studio_generation SET status='complete',lease_until=0,message=?,updated_at=? WHERE project_id=?")
        .run('全部待生成分段已保存，请试听核对后合并。', clock(), id);
      return { done: true };
    }
    db.prepare('DELETE FROM studio_generation_attempts WHERE started_at <= ?').run(clock() - DAY_MS);
    const attempts = db.prepare('SELECT started_at FROM studio_generation_attempts ORDER BY started_at').all();
    if (attempts.length >= MAX_REQUESTS) {
      pause(id, '已达到工具在过去 24 小时内的 20 次生成保护上限，请稍后继续。');
      throw fail(429, '已达到工具的生成保护上限，已保存的音频保留');
    }
    const nextAt = attempts.length ? attempts.at(-1).started_at + INTERVAL_MS : 0;
    if (nextAt > clock()) {
      db.prepare('UPDATE studio_generation SET next_at=?,lease_until=? WHERE project_id=?').run(nextAt, clock() + LEASE_MS, id);
      return { waitMs: nextAt - clock(), nextAt };
    }
    const index = remaining[0];
    db.prepare('INSERT INTO studio_generation_attempts (id,started_at) VALUES (?,?)').run(crypto.randomUUID(), clock());
    db.prepare('UPDATE studio_generation SET current_index=?,next_at=NULL,lease_until=?,updated_at=? WHERE project_id=?')
      .run(index, clock() + LEASE_MS, clock(), id);
    return { index, model: MODEL };
  }
  function allowUpload(id, index, token) {
    const r = owner(id, token);
    if (r.current_index !== index) throw fail(409, '这个分段不是当前生成中的分段，请刷新进度');
  }
  function saved(id, index, token) {
    const r = owner(id, token);
    if (r.current_index !== index) throw fail(409, '生成进度已更新');
    db.prepare('UPDATE studio_generation SET remaining=?,current_index=NULL,last_saved_index=?,lease_until=?,updated_at=? WHERE project_id=?')
      .run(JSON.stringify(JSON.parse(r.remaining).filter(i => i !== index)), index, clock() + LEASE_MS, clock(), id);
  }
  function clearReceipt(id) {
    db.prepare('UPDATE studio_generation SET last_saved_index=NULL WHERE project_id=?').run(id);
  }
  function pause(id, message = '已暂停。已保存的分段保留，可以继续生成。') {
    db.prepare("UPDATE studio_generation SET status='paused',current_index=NULL,lease_until=0,next_at=NULL,message=?,updated_at=? WHERE project_id=?")
      .run(String(message).slice(0, 300), clock(), id);
    return state(id);
  }
  return { state, active, start, heartbeat, next, allowUpload, saved, clearReceipt, pause, owner };
}
module.exports = { createGeneration, MODEL, LEASE_MS, INTERVAL_MS, MAX_REQUESTS };
