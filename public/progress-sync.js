'use strict';

// Each explicit playback claims a writer. Old devices and delayed packets are
// fenced out by session IDs and increasing sequence numbers on the server.
class ProgressSync {
  constructor({ request = (...args) => fetch(...args), storage = localStorage, onStatus = () => {} } = {}) {
    this.request = request;
    this.storage = storage;
    this.onStatus = onStatus;
    this.sessions = new Map();
    this.claims = new Map();
  }

  key(id) { return `jtg-audio:pending:${id}`; }

  async call(id, suffix = '', options = {}) {
    const res = await this.request(`/api/shared-progress/${id}${suffix}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10000), ...options,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || '进度同步失败'), { status: res.status });
    return data;
  }

  async retryPending(id) {
    let pending;
    try { pending = JSON.parse(this.storage.getItem(this.key(id))); } catch (_) { return; }
    if (!pending?.sessionId || !Number.isSafeInteger(pending.sequence)) return;
    try {
      await this.call(id, '', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending), keepalive: true });
    } catch (error) {
      if (error.status !== 409 && error.status !== 404) throw error;
    }
    // A newer save may have arrived while this request was in flight.
    if (this.storage.getItem(this.key(id)) === JSON.stringify(pending)) this.storage.removeItem(this.key(id));
  }

  async read(id) {
    await this.retryPending(id);
    return this.call(id);
  }

  begin(id, { positionSeconds, seek = false } = {}) {
    // Rapid play/seek actions in one tab must reach the server in intent order.
    const work = (this.claims.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      await this.retryPending(id);
      const previous = this.sessions.get(id);
      const data = await this.call(id, '/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionSeconds, seek, previousSessionId: previous?.sessionId }),
      });
      this.sessions.set(id, { sessionId: data.sessionId, sequence: data.sequence });
      return data;
    });
    this.claims.set(id, work);
    work.finally(() => { if (this.claims.get(id) === work) this.claims.delete(id); }).catch(() => {});
    return work;
  }

  async save(id, positionSeconds) {
    const session = this.sessions.get(id);
    if (!session) return;
    const body = { sessionId: session.sessionId, sequence: ++session.sequence, positionSeconds };
    const serialized = JSON.stringify(body);
    this.storage.setItem(this.key(id), serialized);
    this.onStatus(id, 'saving');
    try {
      await this.call(id, '', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: serialized, keepalive: true });
      if (this.storage.getItem(this.key(id)) === serialized) this.storage.removeItem(this.key(id));
      if (this.sessions.get(id) === session && session.sequence === body.sequence) this.onStatus(id, 'saved');
    } catch (error) {
      if (this.sessions.get(id) !== session) return;
      if (error.status === 409 || error.status === 404) {
        this.sessions.delete(id);
        if (this.storage.getItem(this.key(id)) === serialized) this.storage.removeItem(this.key(id));
        this.onStatus(id, 'conflict');
      } else if (session.sequence === body.sequence) {
        this.onStatus(id, 'offline');
      }
    }
  }
}

if (typeof module !== 'undefined') module.exports = { ProgressSync };
