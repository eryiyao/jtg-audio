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
      dataset: {}, classList: { add() {}, remove() {} },
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
      removeAttribute(k) { delete this[k]; }, replaceChildren() {}, append() {},
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
    createElement: element, body: element(),
  });
  const local = new Map();
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const window = element();
  const context = vm.createContext({ document, window, console, Intl,
    navigator: { mediaSession: { setActionHandler() {} } },
    crypto: { randomUUID: () => 'test-browser' },
    localStorage: { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => [] }; },
  });
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'));
  run("current = { id: 'episode-1', title: '测试', durationSeconds: 60 }; positionReady = true;");
  return { run, local, requests, timers, window, document, audio: elements.get('audio') };
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
  assert.equal(saved.url, '/api/progress/episode-1');
});
