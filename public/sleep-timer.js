'use strict';

// A wall-clock deadline survives delayed background callbacks and page reloads.
// Storage is tab-scoped: one device must not stop another device's playback.
class SleepTimer {
  constructor({ storage, onTick = () => {}, onExpire = () => {}, now = () => Date.now(),
    schedule = (fn, delay) => setTimeout(fn, delay), cancel = id => clearTimeout(id) } = {}) {
    Object.assign(this, { storage, onTick, onExpire, now, schedule, cancel });
    this.key = 'jtg-audio:sleep-deadline';
    this.deadline = 0;
    this.timeout = null;
  }

  start(minutes) {
    if (![10, 20, 30, 60].includes(minutes)) return false;
    this.deadline = this.now() + minutes * 60000;
    this.persist();
    this.refresh();
    return true;
  }

  restore() {
    let saved;
    try { saved = Number(this.storage?.getItem(this.key)); } catch (_) { return; }
    if (!Number.isFinite(saved) || saved <= 0 || saved > this.now() + 3600000) {
      this.clear();
      return;
    }
    this.deadline = saved;
    this.refresh();
  }

  persist() {
    try {
      if (this.deadline) this.storage?.setItem(this.key, String(this.deadline));
      else this.storage?.removeItem(this.key);
    } catch (_) { /* Playback still stops when browser storage is unavailable. */ }
  }

  clear() {
    this.cancel(this.timeout);
    this.timeout = null;
    this.deadline = 0;
    this.persist();
    this.onTick(0);
  }

  check(now = this.now()) {
    if (!this.deadline || now < this.deadline) return false;
    this.clear();
    this.onExpire();
    return true;
  }

  refresh() {
    this.cancel(this.timeout);
    this.timeout = null;
    const now = this.now();
    if (this.check(now)) return;
    const remaining = this.deadline ? this.deadline - now : 0;
    this.onTick(remaining);
    if (remaining) this.timeout = this.schedule(() => this.refresh(), Math.min(1000, remaining));
  }
}

if (typeof module !== 'undefined') module.exports = { SleepTimer };
