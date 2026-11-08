'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const scrypt = promisify(crypto.scrypt);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const WINDOW_MS = 15 * 60 * 1000;

function createSharing(store, config, { resolveUpload, streamFile }) {
  const db = store.db;
  const now = config.authNow || Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS audio_shares (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS audio_shares_episode ON audio_shares(episode_id, created_at);
  CREATE TABLE IF NOT EXISTS share_sessions (
    token_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES audio_shares(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS share_sessions_share ON share_sessions(share_id);
  CREATE TABLE IF NOT EXISTS share_attempts (
    bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL
  );`);
  const get = db.prepare('SELECT * FROM audio_shares WHERE id = ?');
  const latest = db.prepare('SELECT * FROM audio_shares WHERE episode_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1');
  const active = (share) => !!share && share.revoked_at === null && share.expires_at > now();
  const cleanSessions = db.prepare('DELETE FROM share_sessions WHERE expires_at <= ?');
  const cleanAttempts = db.prepare('DELETE FROM share_attempts WHERE reset_at <= ?');
  cleanSessions.run(now());
  cleanAttempts.run(now());
  const findSession = db.prepare('SELECT 1 FROM share_sessions WHERE token_hash = ? AND share_id = ? AND expires_at > ?');
  const cookieName = config.secureCookies ? '__Secure-jtg_share' : 'jtg_share_dev';
  const owner = express.Router();
  const guest = express.Router();
  let hashing = 0;
  owner.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  function summary(row) {
    return row ? { id: row.id, path: `/s/${row.id}`, createdAt: row.created_at,
      expiresAt: row.expires_at, active: active(row), revoked: row.revoked_at !== null } : null;
  }
  function episode(req, res) {
    const row = store.getEpisode.get(req.params.id);
    if (!row) res.status(404).json({ error: '找不到这条音频' });
    return row;
  }
  function unavailable(res, share) {
    return res.status(share ? 410 : 404).json({ error: '分享已失效，请联系分享者重新发送' });
  }
  function shareFor(req, res) {
    const share = TOKEN.test(req.params.token) ? get.get(req.params.token) : null;
    if (!active(share)) { unavailable(res, share); return null; }
    return share;
  }
  function authenticated(req, share) {
    const cookies = (req.headers.cookie || '').split(';').map((v) => v.trim()).filter((v) => v.startsWith(cookieName + '='));
    if (cookies.length !== 1) return false;
    const value = cookies[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) && !!findSession.get(digest(value), share.id, now());
  }
  function requireGuest(req, res, next) {
    const share = shareFor(req, res);
    if (!share) return;
    if (!authenticated(req, share)) return res.status(401).json({ error: '请输入分享密码' });
    res.locals.share = share;
    next();
  }
  async function hash(password, salt) {
    hashing++;
    try { return await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }); }
    finally { hashing--; }
  }
  const busy = (res) => res.status(429).set('Retry-After', '5').json({ error: '正在处理，请稍后重试' });
  const validPassword = (value) => typeof value === 'string' && [...value].length >= 6 && [...value].length <= 64 && !/[\r\n\0]/.test(value);

  owner.get('/:id/share', (req, res) => {
    if (episode(req, res)) res.json({ share: summary(latest.get(req.params.id)), serverNow: now() });
  });
  owner.post('/:id/share', async (req, res, next) => {
    const row = episode(req, res);
    if (!row) return;
    const hours = req.body?.durationHours;
    const password = req.body?.password === '' || req.body?.password == null
      ? crypto.randomBytes(9).toString('base64url') : req.body.password;
    if (![24, 168].includes(hours) || !validPassword(password)) {
      return res.status(400).json({ error: '请选择 24 小时或 7 天，密码需为 6–64 个字符' });
    }
    if (active(latest.get(row.id))) return res.status(409).json({ error: '已有有效分享，请先撤销再重新生成' });
    if (hashing >= 2) return busy(res);
    try {
      const salt = crypto.randomBytes(16).toString('hex');
      const derived = await hash(password, salt);
      // Recheck after asynchronous hashing: deletion or another create may have won the race.
      if (!episode(req, res)) return;
      if (active(latest.get(row.id))) return res.status(409).json({ error: '已有有效分享，请先撤销再重新生成' });
      const time = now();
      const id = crypto.randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO audio_shares VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(id, row.id, salt, derived.toString('hex'), time, time + hours * 3600000);
      res.status(201).json({ share: summary(get.get(id)), password, serverNow: now() });
    } catch (error) { next(error); }
  });
  owner.delete('/:id/share/:shareId', (req, res) => {
    if (!episode(req, res)) return;
    const share = get.get(req.params.shareId);
    if (!share || share.episode_id !== req.params.id) return res.status(404).json({ error: '找不到这个分享' });
    db.prepare('UPDATE audio_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now(), share.id);
    db.prepare('DELETE FROM share_sessions WHERE share_id = ?').run(share.id);
    res.status(204).end();
  });

  guest.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = config.publicOrigin || `${req.protocol}://${req.get('host')}`;
      if (req.get('X-JTG-Request') !== '1' || (req.get('Origin') && req.get('Origin') !== origin) ||
          (req.get('Sec-Fetch-Site') && req.get('Sec-Fetch-Site') !== 'same-origin')) {
        return res.status(403).json({ error: '请从分享页面内操作' });
      }
    }
    next();
  });
  guest.get('/player.js', (req, res) => res.sendFile(path.join(config.root, 'public/share-player.js')));
  guest.get('/:token', (req, res) => {
    if (!TOKEN.test(req.params.token)) return unavailable(res, null);
    // The shell contains no audio metadata, including for expired or unknown links.
    res.sendFile(path.join(config.root, 'public/share.html'));
  });
  guest.post('/:token/unlock', async (req, res, next) => {
    const share = shareFor(req, res);
    if (!share) return;
    const time = now();
    cleanAttempts.run(time);
    const buckets = [['ip:' + digest(req.ip || 'unknown'), 10], ['all', 100]];
    for (const [bucket, limit] of buckets) {
      const attempts = db.prepare('SELECT * FROM share_attempts WHERE bucket = ?').get(bucket);
      if (attempts?.attempts >= limit) return res.status(429).set('Retry-After', String(Math.ceil((attempts.reset_at - time) / 1000)))
        .json({ error: '尝试次数较多，请 15 分钟后再试' });
    }
    if (hashing >= 2) return busy(res);
    for (const [bucket] of buckets) db.prepare(`INSERT INTO share_attempts VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1`).run(bucket, time + WINDOW_MS);
    if (!validPassword(req.body?.password)) return res.status(401).json({ error: '分享密码不正确，请重试' });
    try {
      const derived = await hash(req.body.password, share.password_salt);
      if (!crypto.timingSafeEqual(derived, Buffer.from(share.password_hash, 'hex'))) return res.status(401).json({ error: '分享密码不正确，请重试' });
      if (!active(get.get(share.id))) return unavailable(res, share);
      cleanSessions.run(now());
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO share_sessions VALUES (?, ?, ?)').run(digest(token), share.id, share.expires_at);
      db.prepare('DELETE FROM share_attempts WHERE bucket = ?').run(buckets[0][0]);
      res.cookie(cookieName, token, { httpOnly: true, secure: config.secureCookies, sameSite: 'lax',
        path: `/s/${share.id}`, maxAge: share.expires_at - now() });
      res.json({ unlocked: true });
    } catch (error) { next(error); }
  });
  guest.get('/:token/session', requireGuest, (req, res) => {
    const share = res.locals.share;
    const audio = store.getEpisode.get(share.episode_id);
    res.json({ title: audio.title, durationSeconds: audio.duration_seconds,
      audioUrl: `/s/${share.id}/audio`, expiresAt: share.expires_at, serverNow: now() });
  });
  guest.get('/:token/audio', requireGuest, (req, res) => {
    const share = res.locals.share;
    const audio = store.getEpisode.get(share.episode_id);
    const file = resolveUpload(config.uploadDir, audio.stored_name);
    if (!file) return res.status(404).json({ error: '找不到音频文件' });
    streamFile(req, res, file, audio.mime_type, () => active(get.get(share.id)) && authenticated(req, share));
  });
  guest.use((req, res) => unavailable(res, null));
  return { owner, guest };
}

module.exports = { createSharing };
