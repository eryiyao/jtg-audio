'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { makeWav } = require('./wav');
const HASH = '$6$rounds=100000$fixtureSalt$9VHstbGMUD2czzqmjs2MuS9o36BnTQfHywVUvfyAOdKu5RuVlR6OuMXq3hRQE9Tzf/hgXEdOGiR6uJNezfAge0';
const ORIGIN = 'https://audio.example.test';
const WRITE = { 'X-JTG-Request': '1', Origin: ORIGIN, 'Content-Type': 'application/json' };

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-share-'));
  const passwordFile = path.join(dir, 'password');
  fs.writeFileSync(passwordFile, `yao:${HASH}\n`, { mode: 0o600 });
  let clock = Date.now(), app, server, base, ownerCookie;
  async function start() {
    app = createApp({ dataDir: path.join(dir, 'data'), uploadDir: path.join(dir, 'uploads'),
      authPasswordFile: passwordFile, publicOrigin: ORIGIN, secureCookies: true, authNow: () => clock });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await new Promise((resolve) => server.close(resolve)); app.locals.db.close(); }
  const ctx = {
    request: (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options }),
    owner: (url, method = 'GET', body) => ctx.request(url, { method, headers: { ...WRITE, Cookie: ownerCookie }, ...(body ? { body: JSON.stringify(body) } : {}) }),
    db: () => app.locals.db,
    uploadDir: path.join(dir, 'uploads'),
    advance: (ms) => { clock += ms; },
    restart: async () => { await stop(); await start(); },
    audio() {
      const id = crypto.randomUUID(), name = id + '.wav', wav = makeWav(2);
      fs.writeFileSync(path.join(dir, 'uploads', name), wav);
      app.locals.db.prepare('INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'Private title ' + id, name, 'test.wav', 'audio/wav', wav.length, 2, new Date(clock).toISOString());
      return id;
    },
    async create(id, durationHours = 24, password = '') {
      const res = await ctx.owner(`/api/episodes/${id}/share`, 'POST', { durationHours, password });
      assert.equal(res.status, 201);
      return res.json();
    },
    async unlock(share, password) {
      const res = await ctx.request(share.path + '/unlock', { method: 'POST', headers: WRITE, body: JSON.stringify({ password }) });
      return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
    },
  };
  try {
    await start();
    const login = await ctx.request('/api/auth/login', { method: 'POST', headers: WRITE, body: JSON.stringify({ password: 'JtgTest-密码-2026', remember: true }) });
    assert.equal(login.status, 200);
    ownerCookie = login.headers.get('set-cookie').split(';')[0];
    ctx.ownerCookie = ownerCookie;
    await fn(ctx);
  } finally { if (server?.listening) await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('share password unlocks only its audio, never the private library or owner progress', async () => {
  await fixture(async (ctx) => {
    const a = ctx.audio(), b = ctx.audio();
    const { share, password } = await ctx.create(a);
    const other = await ctx.create(b, 168, '另一个分享密码');
    assert.equal(share.expiresAt - share.createdAt, 24 * 3600000);
    assert.equal(other.share.expiresAt - other.share.createdAt, 7 * 24 * 3600000);
    const shell = await ctx.request(share.path);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(await shell.text(), new RegExp(a));
    for (const suffix of ['/session', '/audio']) {
      assert.equal((await ctx.request(share.path + suffix)).status, 401);
      assert.equal((await ctx.owner(share.path + suffix)).status, 401); // owner password is not a share password
    }
    assert.equal((await ctx.unlock(share, 'wrong-password')).res.status, 401);
    const { res, cookie } = await ctx.unlock(share, password);
    assert.equal(res.status, 200);
    const header = res.headers.get('set-cookie');
    for (const pattern of [/^__Secure-jtg_share=/, /HttpOnly/, /Secure/, /SameSite=Lax/, new RegExp(`Path=${share.path}`)]) assert.match(header, pattern);
    const headers = { Cookie: cookie };
    const meta = await (await ctx.request(share.path + '/session', { headers })).json();
    assert.equal(meta.title, 'Private title ' + a);
    assert.equal(meta.audioUrl, share.path + '/audio');
    assert.equal(meta.progress, undefined);
    const audio = await ctx.request(meta.audioUrl, { headers: { ...headers, Range: 'bytes=0-15' } });
    assert.equal(audio.status, 206);
    assert.equal((await audio.arrayBuffer()).byteLength, 16);
    assert.match(audio.headers.get('cache-control'), /no-store/);
    assert.equal((await ctx.request(meta.audioUrl, { method: 'HEAD', headers })).status, 200);
    assert.equal((await ctx.request(other.share.path + '/audio', { headers })).status, 401);
    for (const url of ['/api/episodes', '/api/auth/session', '/app.js', '/share-manager.js', `/api/episodes/${a}/audio`, `/api/episodes/${b}/audio`, `/api/episodes/${a}/share`, `/api/shared-progress/${a}`]) {
      assert.equal((await ctx.request(url, { headers })).status, 401, url);
    }
    for (const [url, method] of [[`/api/episodes/${a}`, 'DELETE'], [`/api/shared-progress/${a}`, 'PUT'], [`/api/episodes/${a}/share`, 'POST'], [`/api/episodes/${a}/share/${share.id}`, 'DELETE']]) {
      assert.equal((await ctx.request(url, { method, headers: { ...WRITE, ...headers }, body: '{}' })).status, 401);
    }
    assert.equal(ctx.db().prepare('SELECT COUNT(*) AS n FROM shared_progress').get().n, 0);
    assert.equal(ctx.db().prepare('SELECT COUNT(*) AS n FROM episodes').get().n, 2);
  });
});

test('share secrets are hashed, survive restart, and cannot be read back as plaintext', async () => {
  await fixture(async (ctx) => {
    const id = ctx.audio();
    const { share, password } = await ctx.create(id, 168, '我的独立分享密码');
    const { cookie } = await ctx.unlock(share, password);
    const saved = ctx.db().prepare('SELECT * FROM audio_shares').get();
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(password));
    assert.equal(saved.password_hash.length, 64);
    const token = ctx.db().prepare('SELECT token_hash FROM share_sessions').get().token_hash;
    assert.notEqual(token, cookie.split('=')[1]);
    await ctx.restart();
    assert.equal((await ctx.request(share.path + '/session', { headers: { Cookie: cookie } })).status, 200);
    const read = await (await ctx.owner(`/api/episodes/${id}/share`)).json();
    assert.equal(read.share.id, share.id);
    assert.equal(read.password, undefined);
    assert.equal((await ctx.owner(`/api/episodes/${id}/share`, 'POST', { durationHours: 24 })).status, 409);
    assert.equal((await ctx.unlock(share, password)).res.status, 200);
  });
});

test('expiry at the exact boundary rejects existing cookies, Range, HEAD, and new unlocks', async () => {
  await fixture(async (ctx) => {
    const id = ctx.audio();
    const { share, password } = await ctx.create(id);
    const { cookie } = await ctx.unlock(share, password);
    ctx.advance(24 * 3600000 - 1);
    assert.equal((await ctx.request(share.path + '/session', { headers: { Cookie: cookie } })).status, 200);
    ctx.advance(1);
    for (const method of ['GET', 'HEAD']) assert.equal((await ctx.request(share.path + '/audio', { method, headers: { Cookie: cookie, Range: 'bytes=0-15' } })).status, 410);
    assert.equal((await ctx.request(share.path + '/session', { headers: { Cookie: cookie } })).status, 410);
    assert.equal((await ctx.unlock(share, password)).res.status, 410);
    assert.equal((await ctx.owner(`/api/episodes/${id}/audio`)).status, 200);
    const replacement = await ctx.create(id);
    assert.notEqual(replacement.share.id, share.id);
    assert.equal((await ctx.request(replacement.share.path + '/audio', { headers: { Cookie: cookie } })).status, 401);
  });
});

test('revoking one share and deleting an audio invalidate guest access without changing other audio', async () => {
  await fixture(async (ctx) => {
    const a = ctx.audio(), b = ctx.audio();
    const { share, password } = await ctx.create(a);
    const { cookie } = await ctx.unlock(share, password);
    assert.equal((await ctx.owner(`/api/episodes/${b}/share/${share.id}`, 'DELETE')).status, 404);
    assert.equal((await ctx.owner(`/api/episodes/${a}/share/${share.id}`, 'DELETE')).status, 204);
    assert.equal((await ctx.request(share.path + '/audio', { headers: { Cookie: cookie } })).status, 410);
    assert.equal((await ctx.unlock(share, password)).res.status, 410);
    assert.equal(ctx.db().prepare('SELECT COUNT(*) AS n FROM share_sessions').get().n, 0);
    const next = await ctx.create(a);
    await ctx.unlock(next.share, next.password);
    assert.equal((await ctx.owner(`/api/episodes/${a}`, 'DELETE')).status, 204);
    assert.equal(ctx.db().prepare('SELECT COUNT(*) AS n FROM audio_shares').get().n, 0);
    assert.equal(ctx.db().prepare('SELECT COUNT(*) AS n FROM share_sessions').get().n, 0);
    assert.equal((await ctx.request(next.share.path + '/session', { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await ctx.owner(`/api/episodes/${b}/audio`)).status, 200);
  });
});

test('creation and unlock reject cross-origin writes, invalid inputs, and duplicate creation races', async () => {
  await fixture(async (ctx) => {
    const id = ctx.audio(), url = `/api/episodes/${id}/share`;
    for (const body of [{ durationHours: 1 }, { durationHours: '24' }, { durationHours: 168, password: 'short' }, { durationHours: 24, password: 'has\nnewline' }]) {
      assert.equal((await ctx.owner(url, 'POST', body)).status, 400);
    }
    const creations = await Promise.all([ctx.owner(url, 'POST', { durationHours: 24 }), ctx.owner(url, 'POST', { durationHours: 24 })]);
    assert.deepEqual(creations.map((r) => r.status).sort(), [201, 409]);
    const { share, password } = await creations.find((r) => r.status === 201).json();
    for (const headers of [{ 'Content-Type': 'application/json' }, { ...WRITE, Origin: 'https://other.example' }, { ...WRITE, 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await ctx.request(share.path + '/unlock', { method: 'POST', headers, body: JSON.stringify({ password }) })).status, 403);
      assert.equal((await ctx.request(url + '/' + share.id, { method: 'DELETE', headers: { ...headers, Cookie: ctx.ownerCookie } })).status, 403);
    }
  });
});

test('share password attempts are limited across links and service restarts, independently of owner login', async () => {
  await fixture(async (ctx) => {
    const a = await ctx.create(ctx.audio()), b = await ctx.create(ctx.audio());
    for (let i = 0; i < 10; i++) assert.equal((await ctx.unlock(i % 2 ? a.share : b.share, 'wrong-password')).res.status, 401);
    await ctx.restart();
    assert.equal((await ctx.unlock(a.share, a.password)).res.status, 429);
    assert.equal((await ctx.owner('/api/episodes')).status, 200);
    ctx.advance(15 * 60000);
    assert.equal((await ctx.unlock(a.share, a.password)).res.status, 200);
  });
});

test('an audio transfer already in flight is closed after share revocation', async () => {
  await fixture(async (ctx) => {
    const id = ctx.audio();
    // A large synthetic file keeps the response open while the client is not consuming it.
    const fd = fs.openSync(path.join(ctx.uploadDir, id + '.wav'), 'r+');
    fs.ftruncateSync(fd, 32 * 1024 * 1024);
    fs.closeSync(fd);
    const { share, password } = await ctx.create(id);
    const { cookie } = await ctx.unlock(share, password);
    const response = await ctx.request(share.path + '/audio', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal((await ctx.owner(`/api/episodes/${id}/share/${share.id}`, 'DELETE')).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await assert.rejects(response.arrayBuffer());
  });
});

test('expiry during password verification cannot issue a guest session', async () => {
  await fixture(async (ctx) => {
    const { share, password } = await ctx.create(ctx.audio());
    const pending = ctx.unlock(share, password);
    // Wait until the handler has recorded the attempt and yielded to scrypt.
    for (let i = 0; i < 100 && !ctx.db().prepare('SELECT 1 FROM share_attempts').get(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    ctx.advance(24 * 3600000);
    const { res } = await pending;
    assert.equal(res.status, 410);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(ctx.db().prepare('SELECT COUNT(*) AS n FROM share_sessions').get().n, 0);
  });
});
