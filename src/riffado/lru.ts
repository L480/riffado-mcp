/**
 * Minimal insertion-order LRU. `Map` iteration/insertion order is defined by
 * JS semantics, so deleting + re-inserting a key on every `get`/`set` is
 * enough to track recency, without a doubly-linked list.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined
    }
    const value = this.map.get(key)!
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
