import { SavedDeviceRecord, TrainerDevice } from './types';

export const SAVED_DEVICES_STORAGE_KEY = 'neonvelo_saved_devices_v1';

export type SavedDeviceRole = 'trainer' | 'hr' | 'cadence';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSavedDevices(storage?: StorageLike | null): SavedDeviceRecord[] {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(SAVED_DEVICES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SavedDeviceRecord =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          item.id.length > 0 &&
          typeof item.name === 'string' &&
          typeof item.lastConnectedAt === 'number' &&
          Number.isFinite(item.lastConnectedAt)
      )
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  } catch {
    return [];
  }
}

export function saveSavedDevices(
  records: readonly SavedDeviceRecord[],
  storage?: StorageLike | null
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(SAVED_DEVICES_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Ignore storage quota errors
  }
}

export function upsertSavedDevice(
  records: readonly SavedDeviceRecord[],
  next: SavedDeviceRecord
): SavedDeviceRecord[] {
  const filtered = records.filter((item) => {
    if (item.id === next.id) return false;
    if (next.role && item.role && item.role === next.role) return false;
    return true;
  });
  return [next, ...filtered].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
}

export function removeSavedDevice(
  records: readonly SavedDeviceRecord[],
  deviceId: string
): SavedDeviceRecord[] {
  return records.filter((item) => item.id !== deviceId);
}

/**
 * Exponential reconnect backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s (capped at 30s).
 */
export function computeReconnectBackoffMs(attemptIndex: number): number {
  const safeAttempt = Math.max(0, Math.floor(attemptIndex));
  return Math.min(30_000, 1_000 * Math.pow(2, safeAttempt));
}

export interface ReconnectRecoveryResult {
  controlGranted: boolean;
  started: boolean;
  targetResentWatts: number | null;
}

/**
 * Post-reconnect FTMS recovery sequence for smart trainers:
 * 1) Re-request control (0x00)
 * 2) Send Start/Resume (0x07)
 * 3) Immediately re-send the current ERG target power (0x05)
 */
export async function runTrainerReconnectRecovery(
  trainer: Pick<TrainerDevice, 'requestControl' | 'startResume' | 'setTargetPower'>,
  targetWatts: number | null,
  shouldResume = true
): Promise<ReconnectRecoveryResult> {
  const controlGranted = await trainer.requestControl();
  if (!controlGranted) {
    return { controlGranted: false, started: false, targetResentWatts: null };
  }
  let started = false;
  if (shouldResume) {
    await trainer.startResume();
    started = true;
  }
  let targetResentWatts: number | null = null;
  if (targetWatts !== null && Number.isFinite(targetWatts) && targetWatts >= 0) {
    const rounded = Math.round(targetWatts);
    await trainer.setTargetPower(rounded);
    targetResentWatts = rounded;
  }
  return { controlGranted, started, targetResentWatts };
}

export interface WatchableBleDevice {
  watchAdvertisements?: (options?: { signal?: AbortSignal }) => Promise<void>;
  addEventListener: (event: string, cb: () => void) => void;
  removeEventListener: (event: string, cb: () => void) => void;
}

/**
 * Wait briefly for an advertisement packet using Web Bluetooth watchAdvertisements()
 * before opening a GATT connection to a previously granted device.
 * Resolves true if an advertisement arrived, or false if unsupported/timed out.
 */
export async function waitForBleAdvertisement(
  device: WatchableBleDevice,
  timeoutMs = 4500
): Promise<boolean> {
  if (typeof device.watchAdvertisements !== 'function') {
    return false;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (seen: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      device.removeEventListener('advertisementreceived', onAdv);
      try {
        controller?.abort();
      } catch {
        // Ignore abort errors
      }
      resolve(seen);
    };

    const onAdv = () => finish(true);
    device.addEventListener('advertisementreceived', onAdv);

    timer = setTimeout(() => finish(false), Math.max(250, timeoutMs));

    try {
      const watchPromise = device.watchAdvertisements!(
        controller ? { signal: controller.signal } : undefined
      );
      if (watchPromise && typeof watchPromise.catch === 'function') {
        watchPromise.catch(() => finish(false));
      }
    } catch {
      finish(false);
    }
  });
}
