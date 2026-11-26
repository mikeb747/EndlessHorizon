/**
 * Persistent local storage for completed workouts (IndexedDB with localStorage fallback)
 * so completed rides remain saved across sessions for FIT export or later Strava upload.
 */

import { buildFitFileName, encodeRideToFit } from './fitEncoder';
import { SavedRide } from './types';

const DB_NAME = 'neonvelo_rides_db';
const DB_VERSION = 1;
const STORE_NAME = 'rides';
const FALLBACK_LS_KEY = 'neonvelo_saved_rides_v1';

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
