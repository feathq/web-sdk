// Tiny typed event emitter. We avoid a dependency because every byte
// matters in a browser SDK and our needs are minimal.
export type Listener<T> = (arg: T) => void;

export class Emitter<EventMap> {
  private listeners: { [K in keyof EventMap]?: Set<Listener<EventMap[K]>> } = {};

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners[event]?.delete(listener);
  }

  emit<K extends keyof EventMap>(event: K, arg: EventMap[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    // Snapshot so a listener that adds/removes during emit doesn't break us.
    for (const listener of [...set]) {
      try {
        listener(arg);
      } catch (err) {
        console.error("feat-web-sdk: emitter listener threw", err);
      }
    }
  }

  removeAll(): void {
    this.listeners = {};
  }
}
