'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createApp } = require('../src/server');
const { makeWav } = require('./wav');
const { ProgressSync } = require('../public/progress-sync');

async function withServer(fn, options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-'));
  const app = createApp({
    dataDir: path.join(dir, 'data'),
    uploadDir: path.join(dir, 'uploads'),
    maxUploadMb: options.maxUploadMb || 5,
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base, { dir, app });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    if (!options.dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function wavForm(name, title, seconds = 1) {
  const form = new FormData();
  if (title != null) form.append('title', title);
  form.append('audio', new Blob([makeWav(seconds)], { type: 'audio/wav' }), name);
  return form;
}

test('upload, list, range, progress, and delete', async () => {
  await withServer(async (base, { dir, app }) => {
    const empty = await fetch(`${base}/api/episodes`);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(await empty.json(), []);

    const createdRes = await fetch(`${base}/api/episodes`, {
      method: 'POST',
      body: wavForm('第三期访谈.wav', ''),
    });
    assert.strictEqual(createdRes.status, 201);
    const created = await createdRes.json();
    assert.strictEqual(created.title, '第三期访谈');
    assert.strictEqual(created.mimeType, 'audio/wav');
    assert.ok(created.audioUrl.endsWith('/audio'));

    const listed = await (await fetch(`${base}/api/episodes`)).json();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, created.id);

    const audio = await fetch(`${base}${created.audioUrl}`, { headers: { Range: 'bytes=0-15' } });
    assert.strictEqual(audio.status, 206);
    assert.match(audio.headers.get('content-type'), /^audio\/wav/);
    assert.match(audio.headers.get('content-range'), /^bytes 0-15\//);
    const chunk = Buffer.from(await audio.arrayBuffer());
    assert.strictEqual(chunk.length, 16);
    assert.strictEqual(chunk.toString('ascii', 0, 4), 'RIFF');

    const missing = await fetch(`${base}/api/progress/${created.id}`);
    assert.strictEqual(missing.status, 200);
    assert.strictEqual((await missing.json()).positionSeconds, null);

    const saved = await fetch(`${base}/api/progress/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionSeconds: 12.34, clientKey: 'phone-1' }),
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual((await saved.json()).positionSeconds, 12.3);

    const again = await fetch(`${base}/api/progress/${created.id}?clientKey=phone-1`);
    assert.strictEqual((await again.json()).positionSeconds, 12.3);

    const other = await fetch(`${base}/api/progress/${created.id}?clientKey=phone-2`);
    assert.strictEqual((await other.json()).positionSeconds, null);

    const patched = await fetch(`${base}/api/episodes/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds: 60 }),
    });
    assert.strictEqual(patched.status, 200);
    assert.strictEqual((await patched.json()).durationSeconds, 60);

    const removed = await fetch(`${base}/api/episodes/${created.id}`, { method: 'DELETE' });
    assert.strictEqual(removed.status, 204);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'uploads')), []);
    assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM progress').get().n, 0);
    const after = await (await fetch(`${base}/api/episodes`)).json();
    assert.deepStrictEqual(after, []);
    const gone = await fetch(`${base}/api/progress/${created.id}`);
    assert.strictEqual(gone.status, 404);
  });
});

test('failed file deletion retains the library entry and returns a failure', async (t) => {
  await withServer(async (base, { dir }) => {
    const episode = await (await fetch(`${base}/api/episodes`, {
      method: 'POST', body: wavForm('删除失败验证.wav', '删除失败验证'),
    })).json();
    const unlink = t.mock.method(fs, 'unlinkSync', () => {
      throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' });
    });
    try {
      const result = await fetch(`${base}/api/episodes/${episode.id}`, { method: 'DELETE' });
      assert.equal(result.status, 500);
      const list = await (await fetch(`${base}/api/episodes`)).json();
      assert.equal(list[0].id, episode.id);
      assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, 1);
    } finally { unlink.mock.restore(); }
  });
});

test('rejects non-audio and oversize files', async () => {
  await withServer(async (base) => {
    const form = new FormData();
    form.append('audio', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const bad = await fetch(`${base}/api/episodes`, { method: 'POST', body: form });
    assert.strictEqual(bad.status, 400);

    const big = new FormData();
    big.append('title', '太大');
    big.append('audio', new Blob([Buffer.alloc(1024 * 80)]), 'big.mp3');
    const tooBig = await fetch(`${base}/api/episodes`, { method: 'POST', body: big });
    assert.strictEqual(tooBig.status, 413);
  }, { maxUploadMb: 0.05 });
});

test('audio and progress survive a service restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-restart-'));
  let episode;
  try {
    await withServer(async (base) => {
      episode = await (await fetch(`${base}/api/episodes`, {
        method: 'POST', body: wavForm('重启验证.wav', '重启验证'),
      })).json();
      const result = await fetch(`${base}/api/progress/${episode.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: 'phone', positionSeconds: 0.5 }),
      });
      assert.equal(result.status, 200);
    }, { dir });
    await withServer(async (base) => {
      const list = await (await fetch(`${base}/api/episodes`)).json();
      assert.equal(list[0].id, episode.id);
      const audio = await fetch(`${base}${episode.audioUrl}`);
      assert.equal(audio.status, 200);
      assert.equal((await audio.arrayBuffer()).byteLength, makeWav().length);
      const progress = await (await fetch(`${base}/api/progress/${episode.id}?clientKey=phone`)).json();
      assert.equal(progress.positionSeconds, 0.5);
    }, { dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function memoryStorage() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}

test('independent devices share progress, fence old sessions, and preserve rewind and completion', async () => {
  await withServer(async (base, { app }) => {
    const ep = await (await fetch(`${base}/api/episodes`, { method: 'POST', body: wavForm('同步测试.wav', '同步测试', 60) })).json();
    const statuses = [];
    const device = () => new ProgressSync({ request: (url, opts) => fetch(base + url, opts), storage: memoryStorage(), onStatus: (_, state) => statuses.push(state) });
    const desktop = device(), phone = device();
    await fetch(`${base}/api/progress/${ep.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positionSeconds: 12, clientKey: 'legacy-desktop' }) });
    assert.equal((await desktop.read(ep.id)).positionSeconds, 12);
    assert.equal((await desktop.begin(ep.id, { positionSeconds: 2 })).positionSeconds, 12);
    await desktop.save(ep.id, 33);
    assert.equal((await phone.read(ep.id)).positionSeconds, 33);
    await phone.begin(ep.id, { positionSeconds: 0 });
    await phone.save(ep.id, 45);
    await desktop.save(ep.id, 34); // delayed old-tab background flush
    assert.ok(statuses.includes('conflict'));
    assert.equal((await phone.read(ep.id)).positionSeconds, 45);
    await fetch(`${base}/api/progress/${ep.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positionSeconds: 3, clientKey: 'legacy-desktop' }) });
    assert.equal((await desktop.read(ep.id)).positionSeconds, 45, 'old app versions cannot replace shared progress');
    await phone.save(ep.id, 15); // intentional rewind must not be replaced by max(position)
    assert.equal((await desktop.read(ep.id)).positionSeconds, 15);
    await phone.save(ep.id, 0); // completion clears progress across devices
    assert.equal((await desktop.read(ep.id)).positionSeconds, 0);
    const list = await (await fetch(`${base}/api/episodes`)).json();
    assert.equal(list[0].progress.positionSeconds, 0);
    await fetch(`${base}/api/episodes/${ep.id}`, { method: 'DELETE' });
    assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM shared_progress').get().n, 0);
  });
});

test('out-of-order saves cannot undo a newer seek; failed saves retry without stealing ownership', async () => {
  await withServer(async (base) => {
    const ep = await (await fetch(`${base}/api/episodes`, { method: 'POST', body: wavForm('顺序.wav', '顺序') })).json();
    const storage = memoryStorage();
    let offline = false;
    const desktop = new ProgressSync({ storage, request: (url, opts) => offline ? Promise.reject(new Error('offline')) : fetch(base + url, opts) });
    const session = await desktop.begin(ep.id, { positionSeconds: 0 });
    const put = (sequence, positionSeconds) => fetch(`${base}/api/shared-progress/${ep.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.sessionId, sequence, positionSeconds }) });
    await put(3, 10);
    await put(2, 40);
    assert.equal((await desktop.read(ep.id)).positionSeconds, 10);
    await desktop.begin(ep.id, { positionSeconds: 10 });
    offline = true;
    await desktop.save(ep.id, 25);
    assert.ok(storage.getItem(desktop.key(ep.id)));
    offline = false;
    assert.equal((await desktop.read(ep.id)).positionSeconds, 25);
    assert.equal(storage.getItem(desktop.key(ep.id)), null);
    offline = true;
    await desktop.save(ep.id, 30);
    const phone = new ProgressSync({ storage: memoryStorage(), request: (url, opts) => fetch(base + url, opts) });
    await phone.begin(ep.id, { positionSeconds: 0 });
    await phone.save(ep.id, 50);
    offline = false;
    assert.equal((await desktop.read(ep.id)).positionSeconds, 50, 'an old offline draft cannot overwrite another device');
    assert.equal(storage.getItem(desktop.key(ep.id)), null);
  });
});

test('shared progress and writer fencing survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-shared-'));
  let id, sessionId;
  try {
    await withServer(async (base) => {
      id = (await (await fetch(`${base}/api/episodes`, { method: 'POST', body: wavForm('重启.wav', '重启') })).json()).id;
      const device = new ProgressSync({ storage: memoryStorage(), request: (url, opts) => fetch(base + url, opts) });
      sessionId = (await device.begin(id, { positionSeconds: 0 })).sessionId;
      await device.save(id, 18);
    }, { dir });
    await withServer(async (base) => {
      const saved = await (await fetch(`${base}/api/shared-progress/${id}`)).json();
      assert.equal(saved.positionSeconds, 18);
      assert.equal(saved.sessionId, sessionId);
    }, { dir });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
