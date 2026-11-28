/**
 * Client-side helper for communicating with the server-side Strava API proxy
 * (/api/strava/*) so OAuth secrets and tokens stay strictly on the server.
 */

import { buildFitFileName, encodeRideToFit } from './fitEncoder';
import { SavedRide } from './types';

export interface StravaStatusResponse {
  serverAvailable: boolean;
  configured: boolean;
  canUpload: boolean;
  canOAuth: boolean;
  hasRefreshToken: boolean;
  athleteName: string | null;
}

export interface StravaUploadResult {
  ok: boolean;
  uploadId?: number | null;
  activityId?: number | null;
  status?: string;
  error?: string;
  needsSetup?: boolean;
  duplicate?: boolean;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export async function fetchStravaStatus(): Promise<StravaStatusResponse> {
  try {
    const res = await fetch('/api/strava/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        serverAvailable: false,
        configured: false,
        canUpload: false,
        canOAuth: false,
        hasRefreshToken: false,
        athleteName: null,
      };
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        serverAvailable: false,
        configured: false,
        canUpload: false,
        canOAuth: false,
        hasRefreshToken: false,
        athleteName: null,
      };
    }
    const data = (await res.json()) as Partial<StravaStatusResponse>;
    return {
      serverAvailable: true,
      configured: Boolean(data.configured),
      canUpload: Boolean(data.canUpload),
      canOAuth: Boolean(data.canOAuth),
      hasRefreshToken: Boolean(data.hasRefreshToken),
      athleteName: typeof data.athleteName === 'string' ? data.athleteName : null,
    };
  } catch {
    return {
      serverAvailable: false,
      configured: false,
      canUpload: false,
      canOAuth: false,
      hasRefreshToken: false,
      athleteName: null,
    };
  }
}

export async function openStravaOAuthPopup(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/strava/auth-url', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !data.url) {
      return {
        ok: false,
        error:
          data.error ||
          'Strava OAuth requires STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in Settings → Secrets.',
      };
    }

    const popup = window.open(
      data.url,
      'strava_oauth_popup',
      'width=600,height=720,noopener=no'
    );
    if (!popup) {
      return {
        ok: false,
        error: 'Popup was blocked by your browser. Please allow popups and try again.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Could not reach the Strava upload server from this hosting mode.',
    };
  }
}

export async function uploadRideToStrava(ride: SavedRide): Promise<StravaUploadResult> {
  try {
    const fitBytes = encodeRideToFit(ride);
    const fitBase64 = uint8ToBase64(fitBytes);
    const fileName = buildFitFileName(ride);
    const activityName = (ride.activityName ?? ride.workoutName).trim() || 'Endless Horizon Ride';
    const descriptionParts = [
      'Recorded with Endless Horizon Cycling',
      ride.sceneryName ? `World: ${ride.sceneryName}` : null,
      ride.gpsRouteName ? `Route: ${ride.gpsRouteName}` : null,
      ride.avgPower > 0 ? `Avg Power: ${ride.avgPower} W` : null,
    ].filter(Boolean);

    const res = await fetch('/api/strava/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'EndlessHorizonCycling',
      },
      body: JSON.stringify({
        rideId: ride.id,
        fileName,
        activityName,
        description: descriptionParts.join(' · '),
        fitBase64,
      }),
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        needsSetup: true,
        error:
          'Strava direct upload requires the app backend server. Use "Save FIT" on static GitHub Pages.',
      };
    }

    const data = (await res.json()) as StravaUploadResult;
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || `Strava upload failed (${res.status}).`,
        needsSetup: Boolean(data.needsSetup),
        duplicate: Boolean(data.duplicate),
      };
    }

    return {
      ok: true,
      uploadId: data.uploadId ?? null,
      activityId: data.activityId ?? null,
      status: data.status || 'Uploaded to Strava',
      duplicate: Boolean(data.duplicate),
    };
  } catch {
    return {
      ok: false,
      error: 'Network error while contacting the Strava upload service.',
    };
  }
}
