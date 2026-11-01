'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SleepTimer } = require('../public/sleep-timer');

function fixture(storage = new Map()) {
  let time = 100000;
  let remaining = 0;
  let expired = 0;
  let next = 0;
  const pending = new Map();
  const options = {
    storage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    now: () => time,
    schedule: (fn, delay) => { pending.set(++next, { fn, delay }); return next; },
    cancel: id => pending.delete(id),
    onTick: ms => { remaining = ms; },
    onExpire: () => { expired++; },
  };
  const timer = new SleepTimer(options);
  return { timer, options, pending, storage, advance: ms => { time += ms; }, remaining: () => remaining, expired: () => expired };
}

test('all presets expire once at their full real-time duration', () => {
  for (const minutes of [10, 20, 30, 60]) {
    const f = fixture();
    assert.equal(f.timer.start(minutes), true);
    f.advance(minutes * 60000 - 1);
    assert.equal(f.timer.check(), false);
    f.advance(1);
    assert.equal(f.timer.check(), true);
    assert.equal(f.expired(), 1);
    f.timer.check(); f.timer.refresh();
    assert.equal(f.expired(), 1);
    assert.equal(f.pending.size, 0);
    assert.equal(f.storage.size, 0);
    assert.equal(f.remaining(), 0);
  }
});

test('changing a duration replaces the old timer; cancel leaves no pending callback', () => {
  const f = fixture();
  f.timer.start(10);
  f.advance(300000);
  f.timer.start(20);
  assert.equal(f.pending.size, 1);
  f.advance(300000);
  f.timer.refresh();
  assert.equal(f.remaining(), 900000);
  assert.equal(f.expired(), 0);
  assert.equal(f.timer.start(-1), false);
  assert.equal(f.timer.start(Infinity), false);
  assert.equal(f.remaining(), 900000);
  const queued = [...f.pending.values()][0].fn;
  f.timer.clear();
  f.advance(2000000);
  queued();
  assert.equal(f.expired(), 0);
  assert.equal(f.pending.size, 0);
});

test('a throttled callback catches up to elapsed time instead of counting timer ticks', () => {
  const f = fixture();
  f.timer.start(10);
  const callback = [...f.pending.values()][0].fn;
  f.advance(450000);
  callback();
  assert.equal(f.remaining(), 150000);
  f.advance(180000);
  [...f.pending.values()][0].fn();
  assert.equal(f.expired(), 1);
});

test('reload retains the deadline while expired, corrupt and unrelated tab state are handled safely', () => {
  const f = fixture();
  f.timer.start(20);
  f.advance(180000);
  const restored = new SleepTimer(f.options);
  restored.restore();
  assert.equal(f.remaining(), 1020000);
  assert.equal(restored.deadline, f.timer.deadline);
  const other = fixture();
  other.timer.restore();
  assert.equal(other.timer.deadline, 0);
  f.advance(1100000);
  new SleepTimer(f.options).restore();
  assert.equal(f.expired(), 1);
  assert.equal(f.storage.size, 0);
  for (const value of ['broken', '-1', 'Infinity', '9999999999999999']) {
    f.storage.set(f.timer.key, value);
    new SleepTimer(f.options).restore();
    assert.equal(f.storage.size, 0);
    assert.equal(f.expired(), 1);
  }
});

test('unavailable storage does not prevent timed stopping', () => {
  const f = fixture();
  const fail = () => { throw new Error('Storage disabled'); };
  const timer = new SleepTimer({ ...f.options, storage: { getItem: fail, setItem: fail, removeItem: fail } });
  timer.restore();
  timer.start(10);
  f.advance(600000);
  timer.check();
  assert.equal(f.expired(), 1);
});
