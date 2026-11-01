'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../src/server');
const { readCredential, verifyPassword, REMEMBER_MS, SESSION_MS } = require('../src/auth');
const { makeWav } = require('./wav');

// Generated with Linux crypt(3), independently of the OpenSSL verifier.
const PASSWORD = 'JtgTest-密码-2026';
const HASH = '$6$rounds=100000$fixtureSalt$9VHstbGMUD2czzqmjs2MuS9o36BnTQfHywVUvfyAOdKu5RuVlR6OuMXq3hRQE9Tzf/hgXEdOGiR6uJNezfAge0';
const ORIGIN = 'https://audio.example.test';
const WRITE = { 'X-JTG-Request': '1', Origin: ORIGIN };

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-auth-'));
  const passwordFile = path.join(dir, 'password');
  fs.writeFileSync(passwordFile, `yao:${HASH}\n`, { mode: 0o600 });
  let clock = Date.now();
  let app, server, base;
  async function start() {
    app = createApp({ dataDir: path.join(dir, 'data'), uploadDir: path.join(dir, 'uploads'),
      authPasswordFile: passwordFile, publicOrigin: ORIGIN, secureCookies: true, authNow: () => clock });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
  }
  const ctx = {
    request: (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options }),
    async login(remember = true, password = PASSWORD, extra = {}) {
      const response = await ctx.request('/api/auth/login', {
        method: 'POST', headers: { ...WRITE, 'Content-Type': 'application/json', ...extra },
        body: JSON.stringify({ password, remember }),
      });
      return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
    advance: (ms) => { clock += ms; },
    restart: async () => { await stop(); await start(); },
    db: () => app.locals.db,
    passwordFile,
  };
  try { await start(); await fn(ctx); }
  finally { if (server?.listening) await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('existing Linux SHA-512 password (including Unicode) is verified without changing it', async () => {
  await fixture(async ({ passwordFile }) => {
    const before = fs.readFileSync(passwordFile);
    const credential = readCredential(passwordFile, 'yao');
    assert.equal(await verifyPassword(PASSWORD, credential), true);
    assert.equal(await verifyPassword(PASSWORD + 'wrong', credential), false);
    assert.deepEqual(fs.readFileSync(passwordFile), before);
  });
});

test('production refuses to start without credentials instead of serving an unprotected library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-auth-prod-'));
  try {
    const result = spawnSync(process.execPath, ['--experimental-sqlite', '-e', "require('./src/server').createApp()"], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production',
        AUTH_PASSWORD_FILE: '', CREDENTIALS_DIRECTORY: '', DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'uploads') },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Production requires an audio password file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('anonymous access reaches only login assets; private APIs, audio and application code stay protected', async () => {
  await fixture(async ({ request }) => {
    const home = await request('/');
    assert.equal(home.status, 303);
    assert.equal(home.headers.get('location'), '/login');
    assert.equal((await request('/login')).status, 200);
    assert.equal((await request('/style.css')).status, 200);
    assert.equal((await request('/healthz')).status, 200);
    for (const url of ['/api/episodes', '/api/auth/session', '/app.js', '/session.js', '/sleep-timer.js', '/api/episodes/00000000-0000-0000-0000-000000000000/audio']) {
      const response = await request(url);
      assert.equal(response.status, 401, url);
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await request('/api/episodes', { headers: { Authorization: 'Basic ' + Buffer.from('yao:' + PASSWORD).toString('base64') } })).status, 401);
  });
});

test('remembered login uses a 30-day secure host-only cookie and survives a service restart', async () => {
  await fixture(async ({ login, request, restart, db }) => {
    const { response, cookie } = await login();
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie');
    for (const pattern of [/^__Host-jtg_audio_session=/, /Max-Age=2592000/, /HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\//]) assert.match(header, pattern);
    assert.doesNotMatch(header, /Domain=/);
    const saved = db().prepare('SELECT * FROM login_sessions').get();
    assert.equal(saved.expires_at - saved.created_at, REMEMBER_MS);
    assert.notEqual(saved.token_hash, cookie.split('=')[1]);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(PASSWORD));
    const before = await request('/api/auth/session', { headers: { Cookie: cookie } });
    assert.equal(before.status, 200);
    assert.equal(before.headers.get('set-cookie'), null); // fixed lifetime, no hidden extension
    await restart();
    assert.equal((await request('/api/episodes', { headers: { Cookie: cookie } })).status, 200);
  });
});

test('expiry is enforced by the server, and non-remembered login has no persistent cookie', async () => {
  await fixture(async ({ login, request, advance }) => {
    const short = await login(false);
    assert.equal(short.response.status, 200);
    assert.doesNotMatch(short.response.headers.get('set-cookie'), /Max-Age|Expires/);
    const long = await login(true);
    advance(SESSION_MS + 1);
    assert.equal((await request('/api/episodes', { headers: { Cookie: short.cookie } })).status, 401);
    assert.equal((await request('/api/episodes', { headers: { Cookie: long.cookie } })).status, 200);
    advance(REMEMBER_MS - SESSION_MS);
    assert.equal((await request('/api/episodes', { headers: { Cookie: long.cookie } })).status, 401);
  });
});

test('login rotates tokens; logout revokes only this device and rejects replay', async () => {
  await fixture(async ({ login, request }) => {
    const first = await login();
    const other = await login();
    const rotated = await login(true, PASSWORD, { Cookie: first.cookie });
    assert.notEqual(first.cookie, rotated.cookie);
    assert.equal((await request('/api/episodes', { headers: { Cookie: first.cookie } })).status, 401);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { ...WRITE, Cookie: rotated.cookie } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.equal((await request('/api/episodes', { headers: { Cookie: rotated.cookie } })).status, 401);
    assert.equal((await request('/api/episodes', { headers: { Cookie: other.cookie } })).status, 200);
    assert.equal((await request('/api/episodes', { headers: { Cookie: other.cookie + '; ' + other.cookie } })).status, 401);
  });
});

test('cross-origin writes and HTML forms cannot login, upload, or logout', async () => {
  await fixture(async ({ login, request }) => {
    const { cookie } = await login();
    for (const url of ['/api/auth/login', '/api/auth/logout', '/api/episodes']) {
      for (const headers of [{}, { 'X-JTG-Request': '1', Origin: 'https://other.example.test' }, { ...WRITE, 'Sec-Fetch-Site': 'cross-site' }]) {
        assert.equal((await request(url, { method: 'POST', headers: { Cookie: cookie, ...headers } })).status, 403);
      }
    }
    assert.equal((await request('/api/episodes', { headers: { Cookie: cookie } })).status, 200);
  });
});

test('wrong password is rejected; login throttling survives restart and recovers after cooldown', async () => {
  await fixture(async ({ login, restart, advance }) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await login(true, 'incorrect-test-password')).response.status, 401);
    assert.equal((await login()).response.status, 429);
    await restart();
    assert.equal((await login()).response.status, 429);
    advance(15 * 60 * 1000 + 1);
    assert.equal((await login()).response.status, 200);
  });
});

test('authenticated audio supports range; upload/delete require login and password rotation revokes sessions', async () => {
  await fixture(async ({ login, request, restart, passwordFile, db }) => {
    const { cookie } = await login();
    const form = new FormData();
    form.append('audio', new Blob([makeWav(1)], { type: 'audio/wav' }), 'auth-test.wav');
    const uploaded = await request('/api/episodes', { method: 'POST', headers: { ...WRITE, Cookie: cookie }, body: form });
    assert.equal(uploaded.status, 201);
    const episode = await uploaded.json();
    assert.equal((await request(episode.audioUrl)).status, 401);
    const audio = await request(episode.audioUrl, { headers: { Cookie: cookie, Range: 'bytes=0-15' } });
    assert.equal(audio.status, 206);
    assert.equal(audio.headers.get('cache-control'), 'private, no-store');
    assert.equal((await audio.arrayBuffer()).byteLength, 16);
    const newHash = HASH.replace('fixtureSalt', 'differentSalt');
    fs.writeFileSync(passwordFile, 'yao:' + newHash + '\n');
    await restart();
    assert.equal((await request('/api/episodes', { headers: { Cookie: cookie } })).status, 401);
    assert.equal(db().prepare('SELECT count(*) AS n FROM episodes').get().n, 1);
    assert.equal(db().prepare('SELECT count(*) AS n FROM login_sessions').get().n, 0);
  });
});
