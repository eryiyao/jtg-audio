'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../src/server');
const { splitText } = require('../src/studio-text');
const media = require('../src/studio-media');
const { makeWav } = require('./wav');

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtg-studio-'));
  let app, server, base;
  async function start(legacyStudioEnabled = true) {
    app = createApp({ dataDir: path.join(dir, 'data'), uploadDir: path.join(dir, 'uploads'), maxUploadMb: 2, legacyStudioEnabled });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await app.locals.studio?.waitForIdle(); await new Promise(resolve => server.close(resolve)); app.locals.db.close(); }
  const ctx = {
    dir, db: () => app.locals.db,
    request: (url, options) => fetch(base + url, options),
    async json(url, method = 'GET', body) {
      const response = await fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
    async create(text = '这是测试正文。', extra = {}) {
      const result = await ctx.json('/api/studio/projects', 'POST', { id: crypto.randomUUID(), title: '虚构测试文章', text, target: 500, ...extra });
      assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
    },
    async upload(p, index = 1, bytes = makeWav(2), name = 'test.wav') {
      const form = new FormData(); form.append('audio', new Blob([bytes]), name);
      const response = await ctx.request(`/api/studio/projects/${p.id}/segments/${index}/audio`, { method: 'POST', headers: { 'X-JTG-Revision': String(p.revision) }, body: form });
      return { status: response.status, body: await response.json() };
    },
    async review(p, index = 1) {
      const result = await ctx.json(`/api/studio/projects/${p.id}/segments/${index}`, 'PATCH', { revision: p.revision, reviewed: true });
      assert.equal(result.status, 200); return result.body;
    },
    async restart(enabled = true) { await stop(); await start(enabled); },
    async merged(id) { await app.locals.studio.waitForIdle(); return (await ctx.json(`/api/studio/projects/${id}`)).body; },
  };
  try { await start(); await fn(ctx); } finally { if (server?.listening) await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('listening mode retires studio routes without changing stored drafts or segment audio', async () => {
  await fixture(async c => {
    const p = (await c.upload(await c.create())).body;
    const files = fs.readdirSync(path.join(c.dir, 'data/studio', p.id));
    const bytes = fs.readFileSync(path.join(c.dir, 'data/studio', p.id, files[0]));
    await c.restart(false);
    const page = await c.request('/studio.html', { redirect: 'manual' });
    assert.equal(page.status, 303); assert.equal(page.headers.get('location'), '/');
    assert.ok(!(await (await c.request('/')).text()).includes('studio-entry'));
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      assert.equal((await c.request(`/api/studio/projects/${p.id}`, { method })).status, 410);
    }
    assert.equal((await c.request(`/api/studio/projects/${p.id}/generation`, { method: 'POST' })).status, 410);
    assert.equal((await c.request('/api/episodes')).status, 200);
    assert.deepEqual(fs.readFileSync(path.join(c.dir, 'data/studio', p.id, files[0])), bytes);
    await c.restart(true);
    assert.deepEqual((await c.json(`/api/studio/projects/${p.id}`)).body, p);
  });
});

test('splitting preserves Chinese, English, numbers, whitespace and emoji without losing text', () => {
  const source = ('这是一段有句号的正文。价格是 3.14 元。\n\nEnglish sentence. 😀\n').repeat(170);
  for (const size of [500, 800, 1000, 1600]) {
    const split = splitText(source, size);
    assert.equal(split.segments.join(''), source.trim());
    assert.ok(split.segments.every(s => Array.from(s).length <= size && s.length > 0));
    assert.ok(split.segments.slice(0, -1).every(s => s.endsWith('\n')));
    assert.ok(split.segments.every(s => !s.startsWith('\ude00') && !s.endsWith('\ud83d')));
  }
  const long = splitText('字'.repeat(1201), 500);
  assert.deepEqual(long.segments.map(s => s.length), [500, 500, 201]);
  assert.equal(splitText('  首行\r\n次行  ').text, '首行\n次行');
  assert.throws(() => splitText('   ')); assert.throws(() => splitText('字'.repeat(100001)));
  assert.throws(() => splitText('正文', 0));
});

test('long drafts, fixed voice and segment progress persist; retries and stale devices cannot overwrite', async () => {
  await fixture(async c => {
    assert.equal((await c.request('/api/studio/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
    assert.equal((await c.json('/api/studio/preview', 'POST', { text: '字'.repeat(400000) })).status, 413);
    const id = crypto.randomUUID(), body = { id, title: '<script>仅作为标题</script>', text: '自然朗读。\n'.repeat(5000), target: 1000, voice: 'Charon', style: '保持自然沉稳。' };
    let response = await c.json('/api/studio/projects', 'POST', body);
    assert.equal(response.status, 201); let p = response.body;
    assert.equal(p.segments.map(s => s.text).join(''), body.text.trim());
    assert.equal((await c.json('/api/studio/projects', 'POST', body)).body.id, id);
    assert.equal((await c.json('/api/studio/projects', 'POST', { ...body, text: '不同正文' })).status, 409);
    assert.equal((await c.json(`/api/studio/projects/${id}/segments/1`, 'PATCH', { revision: p.revision, reviewed: true })).status, 400);
    response = await c.json(`/api/studio/projects/${id}/segments/1`, 'PATCH', { revision: p.revision, copied: true });
    assert.equal(response.status, 200);
    assert.equal((await c.json(`/api/studio/projects/${id}/segments/1`, 'PATCH', { revision: p.revision, copied: true })).status, 409);
    await c.restart(); p = (await c.json(`/api/studio/projects/${id}`)).body;
    assert.equal(p.voice, 'Charon'); assert.equal(p.style, body.style); assert.equal(p.segments[0].copied, true);
    assert.equal((await c.json('/api/studio/projects')).body.length, 1);
  });
});

test('real decoding, warnings, replacement, duplicate checks and merge produce one ordered playable episode', async () => {
  await fixture(async c => {
    assert.equal((await c.json('/api/studio/config')).body.mediaReady, true, 'Install ffmpeg and ffprobe before running the suite');
    let p = await c.create('字'.repeat(501));
    const base = `/api/studio/projects/${p.id}`;
    assert.equal((await c.json(base + '/merge', 'POST', { revision: p.revision })).status, 409);
    let uploaded = await c.upload(p); assert.equal(uploaded.status, 200); p = uploaded.body;
    assert.ok(p.segments[0].warnings.some(w => w.includes('偏短')));
    assert.equal((await c.upload(p, 2)).status, 409);
    const bad = await c.upload(p, 2, Buffer.from('not a WAV'));
    assert.equal(bad.status, 422); assert.equal((await c.json(base)).body.uploaded, 1);
    const range = await c.request(p.segments[0].audioUrl, { headers: { Range: 'bytes=0-15' } });
    assert.equal(range.status, 206); assert.equal(Buffer.from(await range.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    p = await c.review(p);
    uploaded = await c.upload(p, 1, makeWav(3)); assert.equal(uploaded.status, 200); p = uploaded.body;
    assert.equal(p.segments[0].reviewed, false);
    assert.equal(fs.readdirSync(path.join(c.dir, 'data/studio', p.id)).length, 1);
    p = await c.review(p);
    const secondTone = makeWav(4);
    for (let i = 0; i < (secondTone.length - 44) / 2; i++) secondTone.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 880 * i / 8000) * 6000), 44 + i * 2);
    uploaded = await c.upload(p, 2, secondTone); assert.equal(uploaded.status, 200); p = uploaded.body;
    assert.equal((await c.json(base + '/merge', 'POST', { revision: p.revision })).status, 409);
    p = await c.review(p, 2);
    await c.restart(); p = (await c.json(base)).body;
    assert.equal(p.reviewed, 2);
    const calls = await Promise.all([1, 2].map(() => c.json(base + '/merge', 'POST', { revision: p.revision })));
    assert.ok(calls.every(r => [200, 202].includes(r.status)));
    p = await c.merged(p.id); assert.equal(p.status, 'complete', p.error);
    const episodes = (await c.json('/api/episodes')).body;
    assert.equal(episodes.length, 1); assert.equal(episodes[0].id, p.episodeId);
    assert.ok(Math.abs(episodes[0].durationSeconds - 7) < 0.3);
    const stored = c.db().prepare('SELECT stored_name FROM episodes WHERE id=?').get(p.episodeId).stored_name;
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(c.dir, 'uploads', stored), '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1']);
    function frequency(start) {
      let crossings = 0;
      for (let i = start * 8000; i < (start + 1) * 8000; i++) if (pcm.readInt16LE(i * 2) <= 0 && pcm.readInt16LE((i + 1) * 2) > 0) crossings++;
      return crossings;
    }
    assert.ok(Math.abs(frequency(1) - 440) < 3, 'first segment stays first');
    assert.ok(Math.abs(frequency(5) - 880) < 3, 'second segment stays second');
    const mp3 = await c.request(episodes[0].audioUrl); assert.equal(mp3.status, 200); assert.ok((await mp3.arrayBuffer()).byteLength > 5000);
    assert.equal((await c.json(base + '/merge', 'POST', { revision: 1 })).body.episodeId, p.episodeId);
    assert.equal((await c.upload(p)).status, 409);
    await c.restart(); assert.equal((await c.json(base)).body.episodeId, p.episodeId);
    assert.equal((await c.json(base, 'DELETE', { revision: p.revision })).status, 204);
    assert.equal(fs.existsSync(path.join(c.dir, 'data/studio', p.id)), false);
    assert.equal((await c.json('/api/episodes')).body.length, 1);
    assert.equal((await c.request(episodes[0].audioUrl)).status, 200);
    assert.equal((await c.request(`/api/episodes/${p.episodeId}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(fs.readdirSync(path.join(c.dir, 'uploads')), []);
  });
});

test('playlist references and silence are rejected without replacing an accepted segment', async () => {
  await fixture(async c => {
    let p = await c.create(); p = (await c.upload(p)).body;
    const accepted = p.segments[0].audioUrl;
    const silence = makeWav(5); silence.fill(0, 44);
    assert.equal((await c.upload(p, 1, silence)).status, 422);
    const playlist = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://127.0.0.1:1/private\n#EXT-X-ENDLIST\n');
    assert.equal((await c.upload(p, 1, playlist)).status, 422);
    const latest = (await c.json(`/api/studio/projects/${p.id}`)).body;
    assert.equal(latest.segments[0].audioUrl, accepted);
    assert.equal(fs.readdirSync(path.join(c.dir, 'data/studio', p.id)).length, 1);
  });
});

test('merge failures retain progress and retry successfully; restart cleans partial files', async t => {
  await fixture(async c => {
    let p = await c.create(); p = (await c.upload(p)).body; p = await c.review(p);
    const base = `/api/studio/projects/${p.id}`;
    const mocked = t.mock.method(media, 'mergeAudio', async (manifest, output) => { fs.writeFileSync(output, 'partial'); throw new Error('fixture failure'); });
    assert.equal((await c.json(base + '/merge', 'POST', { revision: p.revision })).status, 202);
    p = await c.merged(p.id); assert.equal(p.status, 'error'); assert.equal(p.reviewed, 1);
    assert.deepEqual(fs.readdirSync(path.join(c.dir, 'uploads')), []);
    assert.equal((await c.json('/api/episodes')).body.length, 0);
    mocked.mock.restore();
    const pending = 'studio-00000000-0000-0000-0000-000000000000.mp3';
    fs.writeFileSync(path.join(c.dir, 'uploads', pending), 'interrupted');
    fs.writeFileSync(path.join(c.dir, 'data/studio', p.id, 'orphan.input'), 'interrupted');
    c.db().prepare("UPDATE studio_projects SET status='merging', pending_name=? WHERE id=?").run(pending, p.id);
    await c.restart(); p = (await c.json(base)).body;
    assert.equal(p.status, 'error'); assert.match(p.error, /重启中断/); assert.equal(p.reviewed, 1);
    assert.deepEqual(fs.readdirSync(path.join(c.dir, 'uploads')), []);
    assert.equal(fs.readdirSync(path.join(c.dir, 'data/studio', p.id)).length, 1);
    assert.equal((await c.json(base + '/merge', 'POST', { revision: p.revision })).status, 202);
    p = await c.merged(p.id); assert.equal(p.status, 'complete');
    await c.request(`/api/episodes/${p.episodeId}`, { method: 'DELETE' });
    p = (await c.json(base)).body; assert.equal(p.episodeId, null);
    assert.equal((await c.json(base + '/merge', 'POST', { revision: p.revision })).status, 202);
    p = await c.merged(p.id); assert.equal(p.status, 'complete'); assert.ok(p.episodeId);
  });
});

test('in-flight processing fences destructive actions and stale upload revisions', async t => {
  await fixture(async c => {
    let p = await c.create();
    const actual = media.checkAudio; let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(media, 'checkAudio', async (...args) => { entered(); await gate; return actual(...args); });
    const uploading = c.upload(p); await started;
    const base = `/api/studio/projects/${p.id}`;
    try {
      assert.equal((await c.json(base, 'DELETE', { revision: p.revision })).status, 409);
      assert.equal((await c.json(base + '/segments/1', 'PATCH', { revision: p.revision, copied: true })).status, 409);
      assert.equal((await c.upload(p)).status, 409);
    } finally { release(); }
    const done = await uploading; assert.equal(done.status, 200);
    assert.equal((await c.upload(p)).status, 409);
  });
});

test('failed draft-file deletion reports failure and retains the task', async t => {
  await fixture(async c => {
    const p = await c.create();
    const mock = t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('fixture permission'), { code: 'EACCES' }); });
    try {
      assert.equal((await c.json(`/api/studio/projects/${p.id}`, 'DELETE', { revision: p.revision })).status, 500);
      assert.equal((await c.json(`/api/studio/projects/${p.id}`)).status, 200);
    } finally { mock.mock.restore(); }
  });
});
