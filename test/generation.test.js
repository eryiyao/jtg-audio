'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const Gemini = require('../public/gemini-client');
const GenerationRunner = require('../public/generation-runner');
const { LEASE_MS, INTERVAL_MS, MAX_REQUESTS } = require('../src/studio-generation');
const { makeWav } = require('./wav');
const KEY = 'AIzaSyntheticFixtureNotARealKey1234567890';

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-generation-'));
  let server, app, base, clock = Date.now();
  const ownRequests = [];
  async function start() {
    app = createApp({ dataDir: path.join(dir, 'data'), uploadDir: path.join(dir, 'uploads'), studioNow: () => clock });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await app.locals.studio.waitForIdle(); await new Promise(resolve => server.close(resolve)); app.locals.db.close(); }
  const c = {
    dir, ownRequests, db: () => app.locals.db,
    advance: ms => { clock += ms; },
    async api(url, method = 'GET', body, headers = {}) {
      const form = body instanceof FormData;
      ownRequests.push({ url, method, body: form ? '[audio]' : body, headers });
      const res = await fetch(base + url, { method, headers: { ...(!form && body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
      const data = res.status === 204 ? null : await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
      return data;
    },
    create: (text = '字'.repeat(501)) => c.api('/api/studio/projects', 'POST', { id: crypto.randomUUID(), title: '自动制作测试', text, target: 500 }),
    claim: (p, extra = {}) => ({ revision: p.revision, token: crypto.randomUUID(), runId: crypto.randomUUID(), mode: 'missing', ...extra }),
    async upload(p, index, token, seconds = 2) {
      const form = new FormData(); form.append('audio', new Blob([makeWav(seconds)]), 'generated.wav');
      return c.api(`/api/studio/projects/${p.id}/segments/${index}/audio`, 'POST', form, { 'X-JTG-Revision': String(p.revision), ...(token ? { 'X-JTG-Generation': token } : {}) });
    },
    runner(generate, options = {}) {
      const statuses = [], projects = [], pending = [];
      const runner = new GenerationRunner({ api: c.api, generate, getKey: () => KEY,
        onProject: p => projects.push(p), onStatus: s => statuses.push(s), onPending: p => pending.push(p), onFinish() {}, ...options });
      runner.wait = async ms => c.advance(ms);
      return { runner, statuses, projects, pending };
    },
    async restart() { await stop(); await start(); },
  };
  try { await start(); await fn(c); } finally { if (server?.listening) await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const audioResponse = seconds => new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: makeWav(seconds).toString('base64') }] }] }), { status: 200 });

test('AI Studio authorization keys are accepted unchanged and unsafe pasted values are rejected', async () => {
  const authKey = 'AQ.SyntheticFixtureNotARealAuthorizationKey123456';
  let request;
  await Gemini.connect(' ' + authKey + ' ', async (url, options) => {
    request = { url, options }; return new Response('{}');
  });
  assert.equal(request.options.headers['x-goog-api-key'], authKey);
  assert.ok(!request.url.includes(authKey));
  for (const value of ['https://example.test/' + authKey, 'curl -H ' + authKey, authKey + '\r\nInjected: 1']) {
    assert.throws(() => Gemini.key(value), /有效/);
  }
});

test('official TTS request keeps verbatim text separate from style and never places secrets in URLs', async () => {
  const requests = [];
  const mock = async (url, options) => { requests.push({ url, options }); return url.endsWith('/interactions') ? audioResponse(2) : new Response('{}'); };
  await Gemini.connect(KEY, mock);
  const text = '正文：三点一四。\n第二段。';
  const blob = await Gemini.generate({ apiKey: KEY, text, voice: 'Charon', style: '平静自然，不增删正文。' }, mock);
  assert.equal(blob.size, makeWav(2).length);
  for (const r of requests) { assert.ok(r.url.startsWith('https://generativelanguage.googleapis.com/v1beta/')); assert.ok(!r.url.includes(KEY)); assert.equal(r.options.credentials, 'omit'); assert.equal(r.options.redirect, 'error'); }
  const request = JSON.parse(requests[1].options.body);
  assert.equal(request.store, false); assert.equal(request.model, 'gemini-3.8-flash-tts');
  assert.equal(request.input[0].content[0].text, text);
  assert.equal(request.input[0].content[0].annotations[0].style, '平静自然，不增删正文。');
  assert.deepEqual(request.generation_config.speech_config, [{ voice: 'Charon' }]);
});

test('quota/access failures never fall back or leak provider error bodies; invalid audio is rejected', async () => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    let calls = 0;
    await assert.rejects(() => Gemini.generate({ apiKey: KEY, text: '正文', voice: 'Charon', style: '自然' }, async () => {
      calls++; return new Response(JSON.stringify({ error: { message: KEY } }), { status });
    }), e => e.status === status && !e.message.includes(KEY));
    assert.equal(calls, 1);
  }
  await assert.rejects(() => Gemini.generate({ apiKey: KEY, text: '正文', voice: 'Charon', style: '' }, async () => { throw new Error(KEY); }), e => e.reason === 'connection' && !e.message.includes(KEY));
  assert.throws(() => Gemini.decode({ status: 'in_progress', steps: [] }), /未完整生成/);
  assert.throws(() => Gemini.decode({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'bm90IGF1ZGlv' }] }] }), /WAV/);
});

test('automatic queue saves every segment, survives lost upload acknowledgements and never sends a key to JTG', async () => {
  await fixture(async c => {
    const p = await c.create(); let calls = 0, lost = false;
    const mockGoogle = async () => audioResponse(++calls + 1);
    const ownApi = async (...args) => {
      const result = await c.api(...args);
      if (!lost && args[0].endsWith('/audio') && args[1] === 'POST') { lost = true; throw new TypeError('lost response'); }
      return result;
    };
    const { runner } = c.runner(options => Gemini.generate(options, mockGoogle), { api: ownApi });
    await runner.run(p, { mode: 'missing' });
    const saved = await c.api(`/api/studio/projects/${p.id}`);
    assert.equal(calls, 2); assert.equal(saved.uploaded, 2); assert.equal(saved.reviewed, 0);
    assert.equal(saved.generation.status, 'complete'); assert.equal(runner.pending, null);
    assert.equal(c.ownRequests.filter(r => r.method === 'POST' && r.url.endsWith('/audio')).length, 2);
    assert.ok(!JSON.stringify(c.ownRequests).includes(KEY));
    assert.ok(!fs.readFileSync(path.join(c.dir, 'data/jtg.sqlite')).includes(Buffer.from(KEY)));
    await c.restart(); assert.equal((await c.api(`/api/studio/projects/${p.id}`)).uploaded, 2);
  });
});

test('Google quota exhaustion pauses after saved segments and resume skips completed audio', async () => {
  await fixture(async c => {
    const p = await c.create(); let calls = 0;
    const { runner, statuses } = c.runner(options => Gemini.generate(options, async () => ++calls === 2 ? new Response('quota', { status: 429 }) : audioResponse(calls + 1)));
    await runner.run(p, { mode: 'missing' });
    let saved = await c.api(`/api/studio/projects/${p.id}`);
    assert.equal(calls, 2); assert.equal(saved.uploaded, 1); assert.equal(saved.generation.status, 'paused');
    assert.match(saved.generation.message, /额度/); assert.ok(statuses.some(s => s.includes('额度')));
    const first = saved.segments[0].audioUrl;
    await runner.run(saved, { mode: 'missing' }); saved = await c.api(`/api/studio/projects/${p.id}`);
    assert.equal(calls, 3); assert.equal(saved.uploaded, 2); assert.equal(saved.segments[0].audioUrl, first);
  });
});

test('pause during generation saves the current segment; failed saving retains a local backup without regenerating', async () => {
  await fixture(async c => {
    const p = await c.create(); let entered, release, calls = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const { runner } = c.runner(async () => { calls++; entered(); await gate; return new Blob([makeWav(2)]); });
    const running = runner.run(p, { mode: 'missing' }); await started; runner.requestPause(); release(); await running;
    let saved = await c.api(`/api/studio/projects/${p.id}`);
    assert.equal(calls, 1); assert.equal(saved.uploaded, 1); assert.equal(saved.generation.status, 'paused');
    let failUpload = true;
    const { runner: retrying, pending } = c.runner(async () => { calls++; return new Blob([makeWav(3)]); }, { api: (...args) => {
      if (failUpload && args[0].endsWith('/audio')) throw Object.assign(new Error('保存失败'), { status: 503 });
      return c.api(...args);
    } });
    await retrying.run(saved, { mode: 'missing' });
    assert.equal(calls, 2); assert.ok(retrying.pending); assert.equal(pending.length, 1);
    failUpload = false; await retrying.retrySave();
    assert.equal(calls, 2); assert.equal(retrying.pending, null);
    saved = await c.api(`/api/studio/projects/${p.id}`); assert.equal(saved.uploaded, 2);
  });
});

test('pending audio never overwrites a newer segment and recognizes an already saved receipt', async () => {
  await fixture(async c => {
    const p = await c.create('短文');
    const { runner } = c.runner(async () => new Blob([makeWav(2)]), { api: (...args) => {
      if (args[0].endsWith('/audio')) throw Object.assign(new Error('保存失败'), { status: 503 });
      return c.api(...args);
    } });
    await runner.run(p, { mode: 'missing' });
    assert.ok(runner.pending);
    const latest = await c.upload(await c.api(`/api/studio/projects/${p.id}`), 1, null, 3);
    runner.api = c.api;
    await assert.rejects(() => runner.retrySave(), /云端音频已被其他操作更新/);
    assert.equal((await c.api(`/api/studio/projects/${p.id}`)).segments[0].audioUrl, latest.segments[0].audioUrl);
    assert.ok(runner.pending);

    assert.equal((await c.api(`/api/studio/projects/${p.id}`)).generation.lastSavedIndex, null);
  });
  await fixture(async c => {
    const p = await c.create('短文'); let saved = false, disconnected = true;
    const { runner } = c.runner(async () => new Blob([makeWav(2)]), { api: async (...args) => {
      if (args[0].endsWith('/audio') && disconnected) {
        if (!saved) { await c.api(...args); saved = true; }
        throw new Error('保存回执丢失');
      }
      if (saved && disconnected && args[1] === undefined) throw new Error('暂时无法读取进度');
      return c.api(...args);
    } });
    await runner.run(p, { mode: 'missing' });
    assert.ok(runner.pending); disconnected = false;
    const uploadsBefore = c.ownRequests.filter(r => r.url.endsWith('/audio')).length;
    await runner.retrySave();
    assert.equal(runner.pending, null);
    assert.equal(c.ownRequests.filter(r => r.url.endsWith('/audio')).length, uploadsBefore);
  });
});

test('generation leases fence competing tabs, stale uploads, manual mutations and restart recovery', async () => {
  await fixture(async c => {
    let p = await c.create(); const base = `/api/studio/projects/${p.id}`, claim = c.claim(p);
    await c.api(base + '/generation', 'POST', claim);
    await c.api(base + '/generation', 'POST', claim); // same start is idempotent
    const headers = { 'X-JTG-Generation': claim.token };
    assert.equal((await c.api(base + '/generation/next', 'POST', {}, headers)).index, 1);
    await assert.rejects(() => c.api(base + '/generation/next', 'POST', {}, headers), e => e.status === 409);
    await assert.rejects(() => c.api(base + '/generation', 'POST', c.claim(p)), e => e.status === 409);
    await assert.rejects(() => c.api(base, 'DELETE', { revision: p.revision }), e => e.status === 409);
    await assert.rejects(() => c.upload(p, 1), e => e.status === 409);
    c.advance(LEASE_MS + 1);
    assert.equal((await c.api(base)).generation.status, 'paused');
    const replacement = c.claim(p); await c.api(base + '/generation', 'POST', replacement);
    await c.api(base + '/generation/next', 'POST', {}, { 'X-JTG-Generation': replacement.token });
    await assert.rejects(() => c.upload(p, 1, claim.token), e => e.status === 409);
    p = await c.upload(p, 1, replacement.token);
    await c.restart(); const saved = await c.api(base);
    assert.equal(saved.uploaded, 1); assert.equal(saved.generation.status, 'paused'); assert.match(saved.generation.message, /重启/);
    assert.ok(!JSON.stringify(saved).includes(replacement.token));
    assert.notEqual(c.db().prepare('SELECT token_hash FROM studio_generation WHERE project_id=?').get(p.id).token_hash, replacement.token);
  });
});

test('generation pacing and rolling safety ceiling survive restart and cannot be reset by deleting drafts', async () => {
  await fixture(async c => {
    const p = await c.create('短文'), base = `/api/studio/projects/${p.id}`;
    for (let i = 0; i < MAX_REQUESTS; i++) {
      const claim = c.claim(p); await c.api(base + '/generation', 'POST', claim);
      const headers = { 'X-JTG-Generation': claim.token };
      const step = await c.api(base + '/generation/next', 'POST', {}, headers);
      if (i === 1) { assert.equal(step.waitMs, INTERVAL_MS); c.advance(step.waitMs); await c.api(base + '/generation/next', 'POST', {}, headers); }
      else assert.equal(step.index, 1);
      await c.api(base + '/generation/pause', 'POST', {}, headers);
      if (i !== 0) c.advance(INTERVAL_MS);
    }
    await c.restart(); const claim = c.claim(p); await c.api(base + '/generation', 'POST', claim);
    await assert.rejects(() => c.api(base + '/generation/next', 'POST', {}, { 'X-JTG-Generation': claim.token }), e => e.status === 429);
    await c.api(base, 'DELETE', { revision: p.revision });
    assert.equal(c.db().prepare('SELECT count(*) AS n FROM studio_generation_attempts').get().n, MAX_REQUESTS);
  });
});
