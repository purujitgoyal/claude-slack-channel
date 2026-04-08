/**
 * Shared test utilities for the slack-channel plugin test suite.
 */

// ---------------------------------------------------------------------------
// FakeTimers — deterministic control over setTimeout / clearTimeout
// ---------------------------------------------------------------------------

export class FakeTimers {
  private timers = new Map<
    object,
    { callback: Function; delay: number; created: number }
  >();
  private elapsed = 0;
  private origSetTimeout = globalThis.setTimeout;
  private origClearTimeout = globalThis.clearTimeout;

  install(): void {
    this.timers.clear();
    this.elapsed = 0;
    const self = this;

    (globalThis as any).setTimeout = (
      cb: Function,
      delay: number,
      ...args: any[]
    ) => {
      const handle = { unref() {}, ref() {} };
      self.timers.set(handle, {
        callback: () => cb(...args),
        delay,
        created: self.elapsed,
      });
      return handle;
    };

    (globalThis as any).clearTimeout = (handle: any) => {
      if (handle != null) self.timers.delete(handle);
    };
  }

  /** Advance time by `ms` and fire all expired callbacks (awaits async ones). */
  async tick(ms: number): Promise<void> {
    this.elapsed += ms;
    const toFire: Function[] = [];
    for (const [handle, t] of this.timers) {
      if (this.elapsed - t.created >= t.delay) {
        toFire.push(t.callback);
        this.timers.delete(handle);
      }
    }
    for (const cb of toFire) {
      await cb();
    }
  }

  /** Number of pending timers. */
  get pending(): number {
    return this.timers.size;
  }

  uninstall(): void {
    globalThis.setTimeout = this.origSetTimeout;
    globalThis.clearTimeout = this.origClearTimeout;
    this.timers.clear();
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export { OUTAGE_THRESHOLD, RECONNECT_DEBOUNCE } from '../src/slack.ts';

export const TEST_CHANNEL_ID = 'C_TEST';
export const TEST_ALLOWED_USER = 'U_ALLOWED';
export const TEST_OTHER_USER = 'U_OTHER';
export const TEST_BOT_TOKEN = 'xoxb-test';
export const TEST_APP_TOKEN = 'xapp-test';
