'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readCredential(file, user) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.startsWith(`${user}:`));
  if (rows.length !== 1) throw new Error('Expected one audio password record');
  const hash = rows[0].split(':')[1];
  const match = /^\$6\$((?:rounds=(\d+)\$)?[./a-zA-Z0-9]{1,16})\$[./a-zA-Z0-9]{86}$/.exec(hash);
  if (!match || (match[2] && (+match[2] < 1000 || +match[2] > 1000000))) {
    throw new Error('Audio password must use a supported SHA-512 crypt record');
  }
  return { hash, salt: match[1], revision: digest(`${user}:${hash}`) };
}

function verifyPassword(password, credential) {
  return new Promise((resolve, reject) => {
    // Password goes only through stdin, never argv, a shell, or a log.
    const child = execFile('openssl', ['passwd', '-6', '-salt', credential.salt, '-stdin'],
      { timeout: 10000, maxBuffer: 2048, encoding: 'utf8' }, (error, stdout) => {
        if (error) return reject(new Error('Password verification unavailable'));
        const actual = Buffer.from(stdout.trim());
        const expected = Buffer.from(credential.hash);
        resolve(actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
      });
    child.stdin.on('error', () => {});
    child.stdin.end(password + '\n');
  });
}

function installAuth(app, db, config) {
  const publicDir = path.join(config.root, 'public');
  app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));
  if (!config.authPasswordFile) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production requires an audio password file');
    app.get('/api/auth/session', (req, res) => res.json({ authenticated: true, enabled: false }));
    return;
  }

  const credential = readCredential(config.authPasswordFile, config.authUser);
  const now = config.authNow || Date.now;
  const cookieName = config.secureCookies ? '__Host-jtg_audio_session' : 'jtg_audio_session_dev';
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/' };
  if (process.env.NODE_ENV === 'production' && (!config.secureCookies || !config.publicOrigin?.startsWith('https://'))) {
    throw new Error('Production requires HTTPS session cookies and PUBLIC_ORIGIN');
  }
  // Persist sessions separately from playback sessions; only token hashes are stored.
  db.exec(`CREATE TABLE IF NOT EXISTS login_sessions (
    token_hash TEXT PRIMARY KEY, credential_revision TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL
  );`);
  const find = db.prepare('SELECT * FROM login_sessions WHERE token_hash = ? AND credential_revision = ? AND expires_at > ?');
  const remove = db.prepare('DELETE FROM login_sessions WHERE token_hash = ?');
  const add = db.prepare('INSERT INTO login_sessions VALUES (?, ?, ?, ?)');
  const clean = db.prepare('DELETE FROM login_sessions WHERE expires_at <= ? OR credential_revision != ?');
  const attempts = db.prepare('SELECT * FROM login_attempts WHERE bucket = ? AND reset_at > ?');
  const record = db.prepare(`INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(bucket)
    DO UPDATE SET attempts = attempts + 1`);
  const cleanAttempts = db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?');
  clean.run(now(), credential.revision);
  cleanAttempts.run(now());
  let verifying = 0;

  function token(req) {
    const values = (req.headers.cookie || '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(cookieName + '='));
    if (values.length !== 1) return null;
    const value = values[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  function session(req) {
    const value = token(req);
    return value ? find.get(digest(value), credential.revision, now()) : null;
  }
  function rejectWrite(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = config.publicOrigin || `${req.protocol}://${req.get('host')}`;
    // Custom header cannot be sent by a cross-origin HTML form. No CORS is enabled.
    if (req.get('X-JTG-Request') !== '1' ||
        (req.get('Origin') && req.get('Origin') !== origin) ||
        (req.get('Sec-Fetch-Site') && req.get('Sec-Fetch-Site') !== 'same-origin')) {
      return res.status(403).json({ error: '请从音频网站内操作' });
    }
    next();
  }

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(rejectWrite);
  app.get('/login', (req, res) => {
    if (session(req)) return res.redirect(303, '/');
    res.sendFile(path.join(publicDir, 'login.html'));
  });
  for (const file of ['style.css', 'login.js', 'assets/icons.svg']) {
    app.get('/' + file, (req, res) => res.sendFile(path.join(publicDir, file)));
  }

  app.post('/api/auth/login', async (req, res) => {
    const time = now();
    cleanAttempts.run(time);
    const bucket = 'ip:' + digest(req.ip || 'unknown');
    for (const [key, limit] of [[bucket, 10], ['all', 100]]) {
      const previous = attempts.get(key, time);
      if (previous?.attempts >= limit) {
        return res.status(429).set('Retry-After', String(Math.ceil((previous.reset_at - time) / 1000)))
          .json({ error: '尝试次数较多，请 15 分钟后再试' });
      }
    }
    if (verifying >= 2) return res.status(429).set('Retry-After', '5').json({ error: '正在处理登录，请稍后重试' });
    record.run(bucket, time + ATTEMPT_WINDOW_MS);
    record.run('all', time + ATTEMPT_WINDOW_MS);
    const password = req.body?.password;
    if (typeof password !== 'string' || !password || [...password].length > 128 || /[\r\n\0]/.test(password)) {
      return res.status(401).json({ error: '密码不正确，请重试' });
    }
    verifying += 1;
    try {
      if (!await verifyPassword(password, credential)) return res.status(401).json({ error: '密码不正确，请重试' });
      clean.run(time, credential.revision);
      const old = token(req);
      if (old) remove.run(digest(old));
      const value = crypto.randomBytes(32).toString('base64url');
      const remember = req.body.remember === true;
      const lifetime = remember ? REMEMBER_MS : SESSION_MS;
      add.run(digest(value), credential.revision, time, time + lifetime);
      db.prepare('DELETE FROM login_attempts WHERE bucket = ?').run(bucket);
      res.cookie(cookieName, value, { ...cookieOptions, ...(remember ? { maxAge: lifetime } : {}) });
      res.json({ authenticated: true });
    } catch (_) {
      res.status(503).json({ error: '暂时无法登录，请稍后重试' });
    } finally { verifying -= 1; }
  });
  app.post('/api/auth/logout', (req, res) => {
    const value = token(req);
    if (value) remove.run(digest(value));
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  app.use((req, res, next) => {
    const current = session(req);
    if (!current) {
      if (['GET', 'HEAD'].includes(req.method) && ['/', '/index.html'].includes(req.path)) return res.redirect(303, '/login');
      return res.status(401).json({ error: '登录已失效，请重新登录' });
    }
    res.locals.loginSession = current;
    next();
  });
  app.get('/api/auth/session', (req, res) => res.json({ authenticated: true, enabled: true, expiresAt: res.locals.loginSession.expires_at }));
}

module.exports = { installAuth, readCredential, verifyPassword, REMEMBER_MS, SESSION_MS };
