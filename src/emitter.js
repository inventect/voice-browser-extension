/** Tiny EventEmitter replacement that works in service workers, pages and Node alike. */
export class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }
  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return false;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        // A misbehaving listener must not break the controller.
        console.error(`listener for "${event}" failed`, err);
      }
    }
    return set.size > 0;
  }
  removeAllListeners() {
    this._listeners.clear();
  }
}
