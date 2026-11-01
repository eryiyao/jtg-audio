'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the actual player event handlers without requiring a browser in CI.
function player() {
  function element() {
    const events = new Map();
    return {
      dataset: {}, classList: { add() {}, remove() {} }, style: { setProperty() {} },
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
      removeAttribute(k) { delete this[k]; }, replaceChildren() {}, append() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelectorAll() { return []; },
      addEventListener(k, fn) { if (!events.has(k)) events.set(k, new Set()); events.get(k).add(fn); },
      removeEventListener(k, fn) { events.get(k)?.delete(fn); },
      emit(k) { for (const fn of [...(events.get(k) || [])]) fn({}); },
      currentTime: 0, duration: 60, ended: false, paused: true,
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
    };
  }
  const elements = new Map();
  const document = Object.assign(element(), {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element, createElementNS: element, body: element(),
  });
  const local = new Map();
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let clock = 100000;
  class TestDate extends Date { static now() { return clock; } }
  const window = element();
  class ProgressSync {
    constructor({ onStatus }) { this.onStatus = onStatus; }
    async read() { return { positionSeconds: 42 }; }
    async begin(id, { positionSeconds }) { return { positionSeconds }; }
    save(id, positionSeconds) {
      requests.push({ url: `/api/shared-progress/${id}`, opts: { method: 'PUT', body: JSON.stringify({ positionSeconds }) } });
    }
  }
  const context = vm.createContext({ document, window, console, Intl, Date: TestDate,
    ProgressSync,
    navigator: { mediaSession: { setActionHandler() {} } },
    crypto: { randomUUID: () => 'test-browser' },
    localStorage: { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => [] }; },
  });
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(__dirname, '../public/sleep-timer.js'), 'utf8'));
  run(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'));
  run("current = { id: 'episode-1', title: '测试', durationSeconds: 60 }; positionReady = true; syncWritable = true;");
  return { run, local, requests, timers, window, document, audio: elements.get('audio'), advance: (ms) => { clock += ms; } };
}

test('a pause within the last second still resumes at that position', () => {
  const p = player();
  p.audio.dataset.pendingSeek = '59.6';
  p.run('applyPendingSeek()');
  assert.equal(p.audio.currentTime, 59.6);
});

test('finishing cancels an older pending sync and stays at zero on page hide', () => {
  const p = player();
  p.audio.currentTime = 59;
  p.run('persistPosition(59)');
  assert.equal(p.timers.size, 1);
  p.audio.currentTime = 60;
  p.audio.ended = true;
  p.audio.emit('ended');
  assert.equal(p.timers.size, 0);
  p.window.emit('pagehide');
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '0');
  assert.equal(JSON.parse(p.requests.at(-1).opts.body).positionSeconds, 0);
});

test('hiding the page immediately saves the actual playback position', () => {
  const p = player();
  p.audio.currentTime = 31.7;
  p.document.visibilityState = 'hidden';
  p.document.emit('visibilitychange');
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '31.7');
  assert.equal(JSON.parse(p.requests.at(-1).opts.body).positionSeconds, 31.7);
});

test('switching tracks flushes the old track before changing the current one', async () => {
  const p = player();
  p.audio.currentTime = 19.2;
  await p.run("openEpisode({ id: 'episode-2', title: '下一条', audioUrl: '/next' })");
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '19.2');
  const saved = p.requests.find((r) => r.opts?.method === 'PUT');
  assert.equal(saved.url, '/api/shared-progress/episode-1');
});

test('backward skipping saves zero and forward skipping clamps to duration', () => {
  const p = player();
  p.audio.currentTime = 8;
  p.audio.dataset.pendingSeek = '8';
  p.run('seekTo(audio.currentTime - 15)');
  assert.equal(p.audio.currentTime, 0);
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '0');
  p.run('seekTo(999)');
  assert.equal(p.audio.currentTime, 60);
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '60');
});

test('speed controls change playback rate without moving the playback position', () => {
  const p = player();
  p.audio.currentTime = 33;
  p.run("speedEl.value = '1.5'; speedEl.emit('change')");
  assert.equal(p.audio.playbackRate, 1.5);
  assert.equal(p.audio.currentTime, 33);
});

test('cloud progress wins over stale local progress', async () => {
  const p = player();
  p.local.set('jtg-audio:pos:episode-1', '8');
  assert.equal(await p.run("savedPosition('episode-1')"), 42);
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '42');
});

test('opening or hiding an idle page cannot write progress', () => {
  const p = player();
  p.audio.currentTime = 8;
  p.run('syncWritable = false');
  p.window.emit('pagehide');
  p.audio.emit('pause');
  assert.equal(p.requests.filter(r => r.opts?.method === 'PUT').length, 0);
});

test('a newer device stops the old player before its pause handler can write', () => {
  const p = player();
  p.audio.paused = false;
  p.audio.currentTime = 20;
  p.run("cloud.onStatus('episode-1', 'conflict')");
  assert.equal(p.audio.paused, true);
  p.audio.emit('pause');
  p.window.emit('pagehide');
  assert.equal(p.requests.filter(r => r.opts?.method === 'PUT').length, 0);
});

test('sleep controls stop playback at the wall-clock deadline and flush the actual position', () => {
  const p = player();
  p.document.getElementById('sleep-10').emit('click');
  p.audio.paused = false;
  p.audio.currentTime = 22;
  p.run("speedEl.value = '2'; speedEl.emit('change'); seekTo(40)");
  p.advance(599999);
  p.audio.emit('timeupdate');
  assert.equal(p.audio.paused, false);
  p.audio.currentTime = 43.2;
  p.advance(1);
  p.audio.emit('timeupdate');
  assert.equal(p.audio.paused, true);
  assert.equal(p.local.get('jtg-audio:pos:episode-1'), '43.2');
  assert.equal(JSON.parse(p.requests.at(-1).opts.body).positionSeconds, 43.2);
  assert.equal(p.document.getElementById('sleep-label').textContent, '睡眠定时');
  assert.equal(p.document.getElementById('play-btn')['aria-pressed'], 'false');
});

test('cancelling sleep does not pause playback or leave a deadline on the next play', () => {
  const p = player();
  p.audio.paused = false;
  p.document.getElementById('sleep-20').emit('click');
  p.document.getElementById('cancel-sleep').emit('click');
  p.advance(1200001);
  p.audio.emit('timeupdate');
  assert.equal(p.audio.paused, false);
  assert.equal(p.run('sleepTimer.deadline'), 0);
});

test('delayed sleep checks on returning to the page or a headset play stop immediately', () => {
  for (const event of ['visibilitychange', 'play']) {
    const p = player();
    p.document.getElementById('sleep-10').emit('click');
    p.advance(700000); // Simulate all ordinary timeout callbacks being suspended.
    p.audio.currentTime = 37;
    p.audio.paused = false;
    if (event === 'play') p.audio.emit('play');
    else { p.document.visibilityState = 'visible'; p.document.emit(event); }
    assert.equal(p.audio.paused, true);
    assert.equal(JSON.parse(p.requests.at(-1).opts.body).positionSeconds, 37);
  }
});

test('sleep expiry on a fenced old device cannot overwrite progress from the active device', () => {
  const p = player();
  p.document.getElementById('sleep-10').emit('click');
  p.run("cloud.onStatus('episode-1', 'conflict')");
  p.advance(600000);
  p.audio.emit('timeupdate');
  assert.equal(p.requests.filter(r => r.opts?.method === 'PUT').length, 0);
});

test('changing tracks and pausing do not restart a sleep countdown', async () => {
  const p = player();
  p.document.getElementById('sleep-30').emit('click');
  const deadline = p.run('sleepTimer.deadline');
  p.advance(5000);
  p.audio.emit('pause');
  await p.run("openEpisode({ id: 'episode-2', title: '下一条', audioUrl: '/next' })");
  assert.equal(p.run('sleepTimer.deadline'), deadline);
});
