/**
 * Persistent local storage for completed workouts and append-only in-progress ride
 * checkpoints (IndexedDB v2 with localStorage fallback) so no ride is ever lost on
 * tab reload, crash, or sleep.
 */

import { buildFitFileName, encodeRideToFit } from './fitEncoder';
import {
  ActiveRideChunk,
  ActiveRideMeta,
  RecordedLap,
  RecordedSample,
  SavedRide,
  UnfinishedRideRecovery,
} from './types';

const DB_NAME = 'neonvelo_rides_db';
const DB_VERSION = 2;
const STORE_NAME = 'rides';
const ACTIVE_META_STORE = 'active_meta';
const ACTIVE_CHUNKS_STORE = 'active_chunks';
const FALLBACK_LS_KEY = 'neonvelo_saved_rides_v1';
const FALLBACK_ACTIVE_META_KEY = 'neonvelo_active_ride_meta_v1';
const FALLBACK_ACTIVE_CHUNKS_KEY = 'neonvelo_active_ride_chunks_v1';

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('startTimeMs', 'startTimeMs', { unique: false });
        }
        if (!db.objectStoreNames.contains(ACTIVE_META_STORE)) {
          db.createObjectStore(ACTIVE_META_STORE, { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains(ACTIVE_CHUNKS_STORE)) {
          const chunkStore = db.createObjectStore(ACTIVE_CHUNKS_STORE, { keyPath: 'id' });
          chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readFallbackRides(): SavedRide[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FALLBACK_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedRide[]) : [];
  } catch {
    return [];
  }
}

function writeFallbackRides(rides: SavedRide[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Keep most recent 20 rides in fallback localStorage to stay safely within quota
    window.localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(rides.slice(0, 20)));
  } catch {
    // Ignore storage quota errors
  }
}

function readFallbackActiveMeta(): ActiveRideMeta | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FALLBACK_ACTIVE_META_KEY);
    return raw ? (JSON.parse(raw) as ActiveRideMeta) : null;
  } catch {
    return null;
  }
}

function readFallbackActiveChunks(sessionId: string): ActiveRideChunk[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FALLBACK_ACTIVE_CHUNKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as ActiveRideChunk[]).filter((c) => c.sessionId === sessionId);
  } catch {
    return [];
  }
}

/**
 * Pure helper to merge ordered append-only chunks into contiguous sample & lap arrays.
 * Deduplicates chunks by seq and sorts strictly by seq ascending.
 */
export function assembleRecoveryFromChunks(
  meta: ActiveRideMeta,
  rawChunks: readonly ActiveRideChunk[]
): UnfinishedRideRecovery {
  const bySeq = new Map<number, ActiveRideChunk>();
  for (const ch of rawChunks) {
    if (ch.sessionId === meta.sessionId) {
      bySeq.set(ch.seq, ch);
    }
  }
  const chunks = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  const samples: RecordedSample[] = [];
  const laps: RecordedLap[] = [];
  for (const ch of chunks) {
    for (let i = 0; i < ch.samples.length; i++) {
      samples.push(ch.samples[i]);
    }
    for (let i = 0; i < ch.closedLaps.length; i++) {
      laps.push(ch.closedLaps[i]);
    }
  }
  return { meta, chunks, samples, laps };
}

/**
 * Async append-only checkpoint write for an in-progress ride.
 * Only writes the updated compact metadata + the new delta chunk (never re-writes prior samples).
 */
export async function appendActiveRideCheckpoint(
  meta: ActiveRideMeta,
  chunk: ActiveRideChunk | null
): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(FALLBACK_ACTIVE_META_KEY, JSON.stringify(meta));
      if (chunk) {
        const prev = readFallbackActiveChunks(meta.sessionId);
        prev.push(chunk);
        window.localStorage.setItem(FALLBACK_ACTIVE_CHUNKS_KEY, JSON.stringify(prev));
      }
    } catch {
      // Ignore storage quota errors
    }
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const stores = chunk ? [ACTIVE_META_STORE, ACTIVE_CHUNKS_STORE] : [ACTIVE_META_STORE];
      const tx = db.transaction(stores, 'readwrite');
      tx.objectStore(ACTIVE_META_STORE).put(meta);
      if (chunk) {
        tx.objectStore(ACTIVE_CHUNKS_STORE).put(chunk);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

/**
 * Load the most recent unfinished in-progress ride checkpoint (if any exists).
 */
export async function loadUnfinishedRide(): Promise<UnfinishedRideRecovery | null> {
  const db = await openDatabase();
  if (!db) {
    const meta = readFallbackActiveMeta();
    if (!meta) return null;
    const chunks = readFallbackActiveChunks(meta.sessionId);
    return assembleRecoveryFromChunks(meta, chunks);
  }

  return new Promise<UnfinishedRideRecovery | null>((resolve) => {
    try {
      const tx = db.transaction([ACTIVE_META_STORE, ACTIVE_CHUNKS_STORE], 'readonly');
      const metaReq = tx.objectStore(ACTIVE_META_STORE).getAll();
      metaReq.onsuccess = () => {
        const metas = (metaReq.result as ActiveRideMeta[]) ?? [];
        if (metas.length === 0) {
          db.close();
          resolve(null);
          return;
        }
        metas.sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs);
        const latest = metas[0];
        const chunkStore = tx.objectStore(ACTIVE_CHUNKS_STORE);
        const index = chunkStore.index('sessionId');
        const chunkReq = index.getAll(latest.sessionId);
        chunkReq.onsuccess = () => {
          const chunks = (chunkReq.result as ActiveRideChunk[]) ?? [];
          db.close();
          resolve(assembleRecoveryFromChunks(latest, chunks));
        };
        chunkReq.onerror = () => {
          db.close();
          resolve(assembleRecoveryFromChunks(latest, []));
        };
      };
      metaReq.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/**
 * Clear all in-progress checkpoint metadata and chunks (after finalizing or discarding).
 */
export async function clearActiveRideCheckpoint(sessionId?: string): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    if (typeof window === 'undefined') return;
    try {
      if (!sessionId) {
        window.localStorage.removeItem(FALLBACK_ACTIVE_META_KEY);
        window.localStorage.removeItem(FALLBACK_ACTIVE_CHUNKS_KEY);
      } else {
        const cur = readFallbackActiveMeta();
        if (!cur || cur.sessionId === sessionId) {
          window.localStorage.removeItem(FALLBACK_ACTIVE_META_KEY);
        }
        const remaining = readFallbackActiveChunks(sessionId);
        if (remaining.length > 0) {
          window.localStorage.removeItem(FALLBACK_ACTIVE_CHUNKS_KEY);
        }
      }
    } catch {
      // Ignore
    }
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([ACTIVE_META_STORE, ACTIVE_CHUNKS_STORE], 'readwrite');
      const metaStore = tx.objectStore(ACTIVE_META_STORE);
      const chunkStore = tx.objectStore(ACTIVE_CHUNKS_STORE);

      if (!sessionId) {
        metaStore.clear();
        chunkStore.clear();
      } else {
        metaStore.delete(sessionId);
        const idx = chunkStore.index('sessionId');
        const keyReq = idx.getAllKeys(sessionId);
        keyReq.onsuccess = () => {
          const keys = keyReq.result ?? [];
          for (const key of keys) {
            chunkStore.delete(key);
          }
        };
      }

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function saveCompletedRide(ride: SavedRide): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    const existing = readFallbackRides().filter((r) => r.id !== ride.id);
    writeFallbackRides([ride, ...existing]);
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(ride);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function listSavedRides(): Promise<SavedRide[]> {
  const db = await openDatabase();
  if (!db) {
    return readFallbackRides().sort((a, b) => b.startTimeMs - a.startTimeMs);
  }

  return new Promise<SavedRide[]>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const list = (req.result as SavedRide[]) ?? [];
        list.sort((a, b) => b.startTimeMs - a.startTimeMs);
        db.close();
        resolve(list);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

export async function deleteSavedRide(rideId: string): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    writeFallbackRides(readFallbackRides().filter((r) => r.id !== rideId));
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(rideId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

/**
 * Generate a Strava-compatible binary Garmin .fit file for the given ride
 * and trigger an immediate browser file download (no window.open popups).
 */
export function downloadRideFitFile(ride: SavedRide): string {
  const fitBytes = encodeRideToFit(ride);
  const fileName = buildFitFileName(ride);
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fileName;
  }

  const blob = new Blob([fitBytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  return fileName;
}
