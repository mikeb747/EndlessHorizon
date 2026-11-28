import crypto from 'crypto';

export interface UploadAuthRequestInfo {
  providedSecret: string | undefined;
  configuredSecret: string | undefined;
  remoteAddress: string | undefined;
  hostHeader: string | undefined;
  forwardedForHeader: string | undefined;
}

export interface UploadAuthResult {
  allowed: boolean;
  statusCode: number;
  error?: string;
  requiresSecret?: boolean;
}

/**
 * Constant-time string comparison using SHA-256 digests so lengths never leak.
 */
export function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const clean = addr.trim().toLowerCase();
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === '::ffff:127.0.0.1' ||
    clean === 'localhost'
  );
}

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const clean = hostHeader.trim().toLowerCase();
  if (clean.startsWith('[::1]')) return true;
  const hostname = clean.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Guard `/api/strava/upload` so a hosted backend cannot be used as an open Strava upload proxy:
 * - When `STRAVA_UPLOAD_SECRET` is configured: caller MUST send a matching `X-Upload-Secret`
 *   header (verified in constant time).
 * - When `STRAVA_UPLOAD_SECRET` is unset: endpoint is strictly localhost-only.
 */
export function verifyStravaUploadAccess(info: UploadAuthRequestInfo): UploadAuthResult {
  const expected = (info.configuredSecret || '').trim();
  const provided = (info.providedSecret || '').trim();

  if (expected.length > 0) {
    if (!provided || !timingSafeSecretEquals(provided, expected)) {
      return {
        allowed: false,
        statusCode: 401,
        requiresSecret: true,
        error:
          'Upload passphrase required. Enter the configured STRAVA_UPLOAD_SECRET to upload rides to Strava.',
      };
    }
    return { allowed: true, statusCode: 200 };
  }

  // No shared secret configured -> restrict strictly to direct localhost requests
  const hasNonLoopbackForwarded =
    typeof info.forwardedForHeader === 'string' &&
    info.forwardedForHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((hop) => !isLoopbackAddress(hop));

  if (
    !hasNonLoopbackForwarded &&
    isLoopbackAddress(info.remoteAddress) &&
    isLoopbackHost(info.hostHeader)
  ) {
    return { allowed: true, statusCode: 200 };
  }

  return {
    allowed: false,
    statusCode: 403,
    requiresSecret: true,
    error:
      'Direct Strava upload is restricted to localhost unless STRAVA_UPLOAD_SECRET is configured on the server.',
  };
}
