'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/share-player.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function player() {
  const elements = new Map(), timers = new Map(), intervals = [], actions = {}, requests = [], saved = new Map();
  let time = 0, timerId = 0;
  let respond = async () => ({ ok: true, json: async () => ({ title: 'Fixture audio', audioUrl: '/s/fixture/audio', serverNow: 0, expiresAt: 10000 }) });
  class Element {
    constructor() { this.events = {}; this.attrs = {}; this.hidden = false; this.value = '1'; this.currentTime = 0; this.duration = 60; this.paused = true; this.style = { setProperty() {} }; }
    addEventListener(type, cb) { (this.events[type] ||= []).push(cb); }
    async emit(type, extra = {}) { for (const cb of this.events[type] || []) await cb({ preventDefault() {}, ...extra }); }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key] || null; }
    removeAttribute(key) { delete this.attrs[key]; }
    set src(value) { this.attrs.src = value; }
    get src() { return this.attrs.src; }
    load() { this.currentTime = 0; }
    async play() { this.paused = false; await this.emit('play'); }
    pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
  }
  const $ = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  $('guest-content').hidden = true;
  const context = { document: { getElementById: $, addEventListener() {}, visibilityState: 'visible' },
    location: { pathname: '/s/fixture' }, performance: { now: () => time },
    navigator: { mediaSession: { setActionHandler: (action, callback) => { actions[action] = callback; }, setPositionState() {} } },
    localStorage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetch: async (url) => { requests.push(url); return respond(url); },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: (fn) => intervals.push(fn), addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(source, context);
  await flush();
  return { $, audio: $('guest-audio'), requests, saved, actions,
    respond: (fn) => { respond = fn; },
    advance: (ms, runTimers = true) => { time += ms; if (runTimers) for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
    poll: async () => { for (const fn of intervals) fn(); await flush(); },
  };
}

test('guest expiry pauses buffered playback and clears its source at the deadline', async () => {
  const p = await player();
  await p.audio.play();
  p.audio.currentTime = 6;
  p.advance(10000);
  assert.equal(p.audio.paused, true);
  assert.equal(p.audio.src, undefined);
  assert.equal(p.$('guest-content').hidden, true);
  assert.equal(p.$('unlock-form').hidden, true);
  assert.match(p.$('guest-error').textContent, /到期/);
  assert.equal(p.saved.get('jtg-share-position:/s/fixture'), '6');
  assert.ok(p.requests.every((url) => url.startsWith('/s/fixture/')));
});

test('delayed timers still enforce expiry on playback events, and stale responses cannot reopen it', async () => {
  const p = await player();
  let resolve;
  p.respond(() => new Promise((done) => { resolve = done; }));
  const pending = p.actions.play();
  await flush();
  p.advance(10001, false);
  await p.audio.play(); // A delayed background callback or headset play still checks the deadline.
  assert.equal(p.audio.paused, true);
  resolve({ ok: true, json: async () => ({ title: 'Stale', audioUrl: '/s/fixture/audio', serverNow: 0, expiresAt: 10000 }) });
  await pending;
  assert.equal(p.audio.src, undefined);
  assert.equal(p.$('guest-content').hidden, true);
});

test('revocation polling stops playback and an offline permission check fails closed', async () => {
  const p = await player();
  await p.audio.play();
  p.respond(async () => { throw new Error('offline'); });
  await p.poll();
  assert.equal(p.audio.paused, true);
  await p.actions.play();
  assert.equal(p.audio.paused, true);
  p.respond(async () => ({ ok: false, status: 410, json: async () => ({ error: '分享已失效' }) }));
  await p.actions.play();
  assert.equal(p.audio.src, undefined);
  assert.equal(p.$('unlock-form').hidden, true);
});

test('a slow permission response cannot extend the share deadline', async () => {
  const p = await player();
  let resolve;
  p.respond(() => new Promise((done) => { resolve = done; }));
  const pending = p.actions.play();
  await flush();
  p.advance(5000);
  resolve({ ok: true, json: async () => ({ title: 'Fixture', audioUrl: '/s/fixture/audio', serverNow: 0, expiresAt: 10000 }) });
  await pending;
  assert.equal(p.audio.paused, false);
  p.advance(5000);
  assert.equal(p.audio.paused, true);
  assert.equal(p.audio.src, undefined);
});
