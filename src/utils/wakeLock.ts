interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

/**
 * Manages Screen Wake Lock while a workout is actively running so the Windows
 * or Android display stays awake throughout the session.
 */
class WakeLockController {
  private sentinel: WakeLockSentinelLike | null = null;
  private shouldHold = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.shouldHold) {
          void this.acquire();
        }
      });
    }
  }

  async request(): Promise<void> {
    this.shouldHold = true;
    await this.acquire();
  }

  async release(): Promise<void> {
    this.shouldHold = false;
    if (this.sentinel && !this.sentinel.released) {
      try {
        await this.sentinel.release();
      } catch {
        // Ignore release errors when document is hidden
      }
    }
    this.sentinel = null;
  }

  private async acquire(): Promise<void> {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock) return;
    if (this.sentinel && !this.sentinel.released) return;
    try {
      this.sentinel = await nav.wakeLock.request('screen');
    } catch {
      // Permission or visibility restriction; safe no-op
    }
  }
}

export const wakeLockController = new WakeLockController();
