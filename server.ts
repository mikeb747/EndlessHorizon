/**
 * Full-stack Express + Vite server for Endless Horizon Cycling.
 * Keeps all Strava API credentials strictly server-side via environment variables
 * and proxies .FIT activity uploads to Strava's v3 Uploads API.
 */

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyStravaUploadAccess } from './src/server/uploadAuth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// Strava API constants (hardcoded allowlisted HTTPS host — zero SSRF surface)
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_UPLOADS_URL = 'https://www.strava.com/api/v3/uploads';
const MAX_FIT_BYTES = 10 * 1024 * 1024; // 10 MB

interface StravaTokenState {
  accessToken: string;
  refreshToken: string;
  expiresAtSec: number;
  athleteName: string;
}

// Runtime token cache seeded strictly from server-side environment variables (never hardcoded!)
const stravaTokens: StravaTokenState = {
  accessToken: (process.env.STRAVA_ACCESS_TOKEN || '').trim(),
  refreshToken: (process.env.STRAVA_REFRESH_TOKEN || '').trim(),
  expiresAtSec: 0,
  athleteName: '',
};

function getStravaClientId(): string {
  return (process.env.STRAVA_CLIENT_ID || '').trim();
}

function getStravaClientSecret(): string {
  return (process.env.STRAVA_CLIENT_SECRET || '').trim();
}

function getStravaRedirectUri(req: express.Request): string {
  const configuredAppUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configuredAppUrl && configuredAppUrl !== 'MY_APP_URL') {
    return `${configuredAppUrl}/auth/strava/callback`;
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}/auth/strava/callback`;
}

async function refreshStravaAccessToken(): Promise<boolean> {
  const clientId = getStravaClientId();
  const clientSecret = getStravaClientSecret();
  const refreshToken = stravaTokens.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    return false;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    return false;
  }

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    athlete?: { firstname?: string; lastname?: string };
  };

  if (!data.access_token) return false;
  stravaTokens.accessToken = data.access_token;
  if (data.refresh_token) {
    stravaTokens.refreshToken = data.refresh_token;
  }
  if (typeof data.expires_at === 'number') {
    stravaTokens.expiresAtSec = data.expires_at;
  }
  if (data.athlete) {
    const full = [data.athlete.firstname, data.athlete.lastname].filter(Boolean).join(' ').trim();
    if (full) stravaTokens.athleteName = full;
  }
  return true;
}

async function ensureValidStravaAccessToken(): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (stravaTokens.accessToken) {
    // Refresh proactively only if we know expiresAtSec and it's within 2 minutes of expiry
    if (stravaTokens.expiresAtSec > 0 && nowSec >= stravaTokens.expiresAtSec - 120) {
      await refreshStravaAccessToken();
    }
    return stravaTokens.accessToken;
  }
  if (stravaTokens.refreshToken && getStravaClientId() && getStravaClientSecret()) {
    const ok = await refreshStravaAccessToken();
    if (ok) return stravaTokens.accessToken;
  }
  return null;
}

async function postFitToStrava(
  token: string,
  fitBytes: Buffer,
  meta: { fileName: string; name: string; description: string; externalId: string }
): Promise<Response> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(fitBytes)], { type: 'application/octet-stream' });
  form.append('file', blob, meta.fileName);
  form.append('data_type', 'fit');
  form.append('sport_type', 'VirtualRide');
  form.append('name', meta.name);
  if (meta.description) {
    form.append('description', meta.description);
  }
  if (meta.externalId) {
    form.append('external_id', meta.externalId);
  }

  return fetch(STRAVA_UPLOADS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
}

const oauthStateNonces = new Map<string, number>();

function issueOAuthStateNonce(): string {
  const now = Date.now();
  for (const [k, exp] of oauthStateNonces.entries()) {
    if (exp <= now) oauthStateNonces.delete(k);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  oauthStateNonces.set(nonce, now + 10 * 60 * 1000);
  return nonce;
}

function consumeOAuthStateNonce(nonce: string): boolean {
  const exp = oauthStateNonces.get(nonce);
  if (!exp) return false;
  oauthStateNonces.delete(nonce);
  return exp > Date.now();
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '14mb' }));

  // 1) Strava integration status (never returns tokens or secrets)
  app.get('/api/strava/status', (_req, res) => {
    const hasAccess = Boolean(stravaTokens.accessToken);
    const hasClientId = Boolean(getStravaClientId());
    const hasClientSecret = Boolean(getStravaClientSecret());
    const hasRefresh = Boolean(stravaTokens.refreshToken);
    const canUpload = hasAccess || (hasClientId && hasClientSecret && hasRefresh);
    const canOAuth = hasClientId && hasClientSecret;

    res.json({
      configured: canUpload || canOAuth,
      canUpload,
      canOAuth,
      hasRefreshToken: hasClientId && hasClientSecret && hasRefresh,
      athleteName: stravaTokens.athleteName || null,
      requiresUploadSecret: Boolean((process.env.STRAVA_UPLOAD_SECRET || '').trim()),
    });
  });

  // 2) Strava OAuth authorize URL for popup-based connection (per AI Studio iframe rules)
  app.get('/api/strava/auth-url', (req, res) => {
    const clientId = getStravaClientId();
    if (!clientId || !getStravaClientSecret()) {
      res.status(400).json({
        error:
          'Strava OAuth requires STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in server environment secrets.',
      });
      return;
    }

    const redirectUri = getStravaRedirectUri(req);
    const stateNonce = issueOAuthStateNonce();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: 'read,activity:write',
      state: stateNonce,
    });

    res.json({
      url: `${STRAVA_AUTH_URL}?${params.toString()}`,
      redirectUri,
    });
  });

  // 3) Strava OAuth callback (handles with & without trailing slash)
  app.get(['/auth/strava/callback', '/auth/strava/callback/'], async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    const errParam = typeof req.query.error === 'string' ? req.query.error : '';
    const stateParam = typeof req.query.state === 'string' ? req.query.state.trim() : '';

    if (errParam || !code || !consumeOAuthStateNonce(stateParam)) {
      res.status(400).send(`<!doctype html><html><body style="font-family:sans-serif;background:#08061a;color:#f8fafc;padding:24px;">
        <p>Strava authorization was cancelled, expired, or denied.</p>
        <script>if(window.opener){window.opener.postMessage({type:'STRAVA_OAUTH_ERROR'},window.location.origin);window.close();}</script>
      </body></html>`);
      return;
    }

    const clientId = getStravaClientId();
    const clientSecret = getStravaClientSecret();
    if (!clientId || !clientSecret) {
      res.status(500).send('Strava credentials are not configured on the server.');
      return;
    }

    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
      });
      const tokenResp = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!tokenResp.ok) {
        throw new Error(`Strava token exchange failed (${tokenResp.status})`);
      }

      const data = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
        athlete?: { firstname?: string; lastname?: string };
      };
      if (!data.access_token) {
        throw new Error('Strava token response missing access_token');
      }

      stravaTokens.accessToken = data.access_token;
      if (data.refresh_token) stravaTokens.refreshToken = data.refresh_token;
      if (typeof data.expires_at === 'number') stravaTokens.expiresAtSec = data.expires_at;
      if (data.athlete) {
        stravaTokens.athleteName = [data.athlete.firstname, data.athlete.lastname]
          .filter(Boolean)
          .join(' ')
          .trim();
      }

      res.send(`<!doctype html><html><body style="font-family:sans-serif;background:#08061a;color:#22d3ee;padding:24px;">
        <p>Strava connected! Closing window...</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'STRAVA_OAUTH_SUCCESS' }, window.location.origin);
            window.close();
          } else {
            window.location.href = '/';
          }
        </script>
      </body></html>`);
    } catch {
      res.status(500).send(`<!doctype html><html><body style="font-family:sans-serif;background:#08061a;color:#fb7185;padding:24px;">
        <p>Could not complete Strava sign-in. Please verify your Client ID and Client Secret.</p>
        <script>if(window.opener){window.opener.postMessage({type:'STRAVA_OAUTH_ERROR'},window.location.origin);}</script>
      </body></html>`);
    }
  });

  // 4) Upload a binary .FIT file to Strava v3 Uploads API
  app.post('/api/strava/upload', async (req, res) => {
    // Basic CSRF / cross-origin safeguard for mutation endpoint
    const xrw = req.get('X-Requested-With');
    if (xrw !== 'EndlessHorizonCycling') {
      res.status(403).json({ error: 'Missing required request header.' });
      return;
    }

    // Shared-secret / localhost-only guard so hosted instances cannot be abused as open Strava proxies
    const uploadAuth = verifyStravaUploadAccess({
      providedSecret: req.get('X-Upload-Secret'),
      configuredSecret: process.env.STRAVA_UPLOAD_SECRET,
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.get('host'),
      forwardedForHeader: req.get('x-forwarded-for'),
    });
    if (!uploadAuth.allowed) {
      res.status(uploadAuth.statusCode).json({
        error: uploadAuth.error || 'Unauthorized Strava upload request.',
        requiresSecret: Boolean(uploadAuth.requiresSecret),
      });
      return;
    }

    const body = req.body as {
      fitBase64?: unknown;
      fileName?: unknown;
      activityName?: unknown;
      name?: unknown;
      description?: unknown;
      rideId?: unknown;
      externalId?: unknown;
    };

    if (typeof body.fitBase64 !== 'string' || body.fitBase64.length < 32) {
      res.status(400).json({ error: 'Invalid or missing FIT binary payload.' });
      return;
    }

    const fitBytes = Buffer.from(body.fitBase64, 'base64');
    if (fitBytes.length < 14 || fitBytes.length > MAX_FIT_BYTES) {
      res.status(400).json({ error: 'FIT payload size out of valid bounds.' });
      return;
    }

    // Validate binary FIT header signature (".FIT" at bytes 8..11)
    if (fitBytes.subarray(8, 12).toString('ascii') !== '.FIT') {
      res.status(400).json({ error: 'Payload is not a valid Garmin .FIT file.' });
      return;
    }

    const rawName = typeof body.activityName === 'string' ? body.activityName : body.name;
    const rawExtId = typeof body.rideId === 'string' ? body.rideId : body.externalId;

    const cleanFileName =
      typeof body.fileName === 'string'
        ? body.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'ride.fit'
        : 'ride.fit';
    const cleanName =
      typeof rawName === 'string' && rawName.trim()
        ? rawName.trim().slice(0, 100)
        : 'Endless Horizon Cycling Ride';
    const cleanDesc =
      typeof body.description === 'string' ? body.description.trim().slice(0, 400) : '';
    const cleanExternalId =
      typeof rawExtId === 'string'
        ? rawExtId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
        : `ehc-${Date.now()}`;

    let token = await ensureValidStravaAccessToken();
    if (!token) {
      res.status(503).json({
        error:
          'Strava is not configured yet. Add STRAVA_ACCESS_TOKEN (or STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET & STRAVA_REFRESH_TOKEN) in Settings → Secrets, or connect your Strava account.',
        needsSetup: true,
      });
      return;
    }

    try {
      let uploadResp = await postFitToStrava(token, fitBytes, {
        fileName: cleanFileName,
        name: cleanName,
        description: cleanDesc,
        externalId: cleanExternalId,
      });

      // Automatically refresh token once if Strava returns 401 Unauthorized
      if (uploadResp.status === 401) {
        const refreshed = await refreshStravaAccessToken();
        if (refreshed && stravaTokens.accessToken) {
          token = stravaTokens.accessToken;
          uploadResp = await postFitToStrava(token, fitBytes, {
            fileName: cleanFileName,
            name: cleanName,
            description: cleanDesc,
            externalId: cleanExternalId,
          });
        }
      }

      const uploadJson = (await uploadResp.json().catch(() => ({}))) as {
        id?: number;
        id_str?: string;
        activity_id?: number | null;
        status?: string;
        error?: string | null;
        message?: string;
      };

      if (!uploadResp.ok) {
        const msg =
          uploadJson.error ||
          uploadJson.message ||
          `Strava rejected the upload (HTTP ${uploadResp.status}).`;
        res.status(uploadResp.status >= 400 && uploadResp.status < 500 ? uploadResp.status : 502).json({
          error: msg,
        });
        return;
      }

      // Briefly poll upload processing status (up to 3 checks x 750ms) to capture activity_id
      let activityId = uploadJson.activity_id ?? null;
      let statusText = uploadJson.status || 'Your activity is being processed.';
      let uploadError = uploadJson.error || null;
      const uploadId = uploadJson.id_str || (uploadJson.id ? String(uploadJson.id) : null);

      if (uploadId && !activityId && !uploadError) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const pollResp = await fetch(`${STRAVA_UPLOADS_URL}/${encodeURIComponent(uploadId)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!pollResp.ok) break;
          const pollJson = (await pollResp.json().catch(() => ({}))) as {
            activity_id?: number | null;
            status?: string;
            error?: string | null;
          };
          activityId = pollJson.activity_id ?? activityId;
          if (pollJson.status) statusText = pollJson.status;
          if (pollJson.error) {
            uploadError = pollJson.error;
            break;
          }
          if (activityId) break;
        }
      }

      if (uploadError) {
        const isDuplicate = /duplicate/i.test(uploadError);
        res.status(isDuplicate ? 409 : 422).json({
          error: uploadError,
          duplicate: isDuplicate,
          uploadId,
        });
        return;
      }

      res.json({
        ok: true,
        uploadId,
        activityId,
        status: statusText,
      });
    } catch {
      res.status(502).json({
        error: 'Network error while communicating with Strava. Please try again.',
      });
    }
  });

  // Mount Vite middleware in development, or serve built dist/ in production
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Endless Horizon Cycling server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
