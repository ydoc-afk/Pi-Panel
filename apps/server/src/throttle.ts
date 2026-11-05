/**
 * Counts failures per key inside a sliding window. Used to slow password guessing: every failed
 * sign-in costs an argon2 verify, so it also caps how much CPU an attacker can make the panel spend.
 */
export class FailureThrottle {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0 if it is not blocked. */
  retryAfter(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
