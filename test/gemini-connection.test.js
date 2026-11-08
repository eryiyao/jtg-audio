'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, DEVICE_KEY, LEGACY_KEY } = require('../public/gemini-connection');
const { key: validate } = require('../public/gemini-client');
const KEY = 'AQ.SyntheticDeviceStorageFixtureNotARealKey';
function storage() {
  const values = new Map();
  return { values, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
function connection(device, session = storage()) { return create({ device: () => device, session: () => session, validate }); }

test('device opt-in survives reopening while an ordinary connection leaves no persistent key', () => {
  const device = storage(), session = storage(), first = connection(device, session);
  assert.deepEqual(first.restore(), { key: '', remembered: false });
  assert.deepEqual(first.save(KEY, false), { ok: true, remembered: false });
  assert.equal(device.values.size, 0);
  assert.equal(connection(device).restore().key, '');
  assert.deepEqual(first.save(KEY, true), { ok: true, remembered: true });
  assert.deepEqual(connection(device).restore(), { key: KEY, remembered: true });
  assert.equal(session.values.size, 0);
});

test('legacy tab opt-in is never promoted silently; clearing removes both kinds of saved key', () => {
  const device = storage(), session = storage(); session.setItem(LEGACY_KEY, KEY);
  const store = connection(device, session);
  assert.deepEqual(store.restore(), { key: KEY, remembered: false });
  assert.equal(device.values.size, 0);
  store.save(KEY, true); assert.equal(session.getItem(LEGACY_KEY), null);
  session.setItem(LEGACY_KEY, KEY);
  assert.equal(store.clear(), true);
  assert.equal(connection(device, session).restore().key, '');
  assert.equal(device.getItem(DEVICE_KEY), null); assert.equal(session.getItem(LEGACY_KEY), null);
});

test('opting out removes the remembered key and malformed saved values are ignored', () => {
  const device = storage(), session = storage(), store = connection(device, session);
  store.save(KEY, true); session.setItem(LEGACY_KEY, KEY); store.save(KEY, false);
  assert.equal(connection(device, session).restore().key, '');
  device.setItem(DEVICE_KEY, 'https://example.test/not-a-key');
  assert.equal(store.restore().key, '');
  assert.throws(() => store.save('invalid', true));
});

test('blocked storage does not claim persistence or clearance and does not skip legacy cleanup', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const session = storage(); session.setItem(LEGACY_KEY, KEY);
  const store = connection(blocked, session);
  assert.deepEqual(store.save(KEY, true), { ok: false, remembered: false });
  assert.equal(store.clear(), false); assert.equal(session.getItem(LEGACY_KEY), null);
  assert.deepEqual(store.restore(), { key: '', remembered: false });
});
