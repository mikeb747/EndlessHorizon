import { useEffect, useState } from 'react';
import {
  Check,
  Clock,
  Download,
  ExternalLink,
  Flag,
  FolderArchive,
  Loader2,
  Mountain,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { formatClock } from '../core/zones';
import { downloadRideFitFile } from '../recording/rideStorage';
import {
  fetchStravaStatus,
  openStravaOAuthPopup,
  StravaStatusResponse,
  uploadRideToStrava,
} from '../recording/stravaClient';
import { SavedRide } from '../recording/types';
import { useAppStore } from '../store/useAppStore';

function formatRideDate(ms: number): string {
  return new Date(ms).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isTrustedOAuthOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.origin === window.location.origin ||
      parsed.hostname.endsWith('.run.app') ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

export function SavedRidesModal() {
  const savedRides = useAppStore((s) => s.savedRides);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const deleteSavedRideById = useAppStore((s) => s.deleteSavedRideById);
  const markRideUploadedToStrava = useAppStore((s) => s.markRideUploadedToStrava);

  const [downloadedId, setDownloadedId] = useState<string | null>(null);
  const [stravaStatus, setStravaStatus] = useState<StravaStatusResponse | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [rideFeedback, setRideFeedback] = useState<
    Record<string, { ok: boolean; message: string; activityId?: number | null }>
  >({});
  const [bannerMessage, setBannerMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStravaStatus().then((status) => {
      if (active) setStravaStatus(status);
    });

    const handleMessage = (event: MessageEvent) => {
      if (!isTrustedOAuthOrigin(event.origin)) return;
      const data = event.data as { type?: string; athleteName?: string } | null;
      if (data?.type === 'STRAVA_OAUTH_SUCCESS') {
        setBannerMessage({
          ok: true,
          text: data.athleteName
            ? `Connected to Strava as ${data.athleteName}. You can now upload rides directly.`
            : 'Connected to Strava. You can now upload rides directly.',
        });
        void fetchStravaStatus().then((status) => {
          if (active) setStravaStatus(status);
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      active = false;
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const handleDownload = (ride: SavedRide) => {
    downloadRideFitFile(ride);
    setDownloadedId(ride.id);
  };

  const handleConnectStrava = async () => {
    const res = await openStravaOAuthPopup();
    if (!res.ok && res.error) {
      setBannerMessage({ ok: false, text: res.error });
    }
  };

  const handleUploadToStrava = async (ride: SavedRide) => {
    if (uploadingId) return;
    setUploadingId(ride.id);
    setBannerMessage(null);
    setRideFeedback((prev) => {
      const next = { ...prev };
      delete next[ride.id];
      return next;
    });

    const result = await uploadRideToStrava(ride);
    setUploadingId(null);

    if (result.ok) {
      await markRideUploadedToStrava(ride.id, result.activityId ?? null);
      setRideFeedback((prev) => ({
        ...prev,
        [ride.id]: {
          ok: true,
          message: result.duplicate
            ? 'Already on Strava.'
            : result.activityId
              ? `Uploaded to Strava (Activity #${result.activityId}).`
              : result.status || 'Uploaded to Strava — processing your .FIT file.',
          activityId: result.activityId ?? null,
        },
      }));
    } else if (result.needsSetup) {
      setBannerMessage({
        ok: false,
        text:
          result.error ||
          'Add STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_ACCESS_TOKEN, and STRAVA_REFRESH_TOKEN in Settings → Secrets to enable direct Strava uploads.',
      });
    } else {
      setRideFeedback((prev) => ({
        ...prev,
        [ride.id]: {
          ok: false,
          message: result.error || 'Strava upload failed.',
        },
      }));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-labelledby="saved-rides-title"
      data-testid="saved-rides-modal"
    >
      <div className="neon-frame-hud rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-cyan-500/25 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <FolderArchive className="w-6 h-6 text-cyan-300 shrink-0" />
            <div className="min-w-0">
              <h2
                id="saved-rides-title"
                className="font-display text-lg font-extrabold text-white tracking-wide"
              >
                Saved Completed Rides
              </h2>
              <p className="text-xs text-slate-400">
                Download Garmin .FIT files or upload directly to Strava
                {stravaStatus?.athleteName ? ` · Connected as ${stravaStatus.athleteName}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {stravaStatus?.canOAuth && !stravaStatus.canUpload && (
              <button
                type="button"
                onClick={() => void handleConnectStrava()}
                data-testid="btn-connect-strava"
                className="min-h-[44px] px-3.5 rounded-md bg-[#fc4c02]/25 border border-[#fc4c02] text-orange-100 hover:bg-[#fc4c02]/40 font-display text-xs font-bold uppercase tracking-wider flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Connect Strava
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveModal(null)}
              aria-label="Close saved rides"
              className="min-w-[48px] min-h-[48px] rounded-md bg-[#110e2d] border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/20 flex items-center justify-center"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {bannerMessage && (
          <div
            data-testid="strava-status-banner"
            className={`mx-6 mt-4 rounded-lg px-4 py-2.5 text-xs border ${
              bannerMessage.ok
                ? 'bg-emerald-950/50 border-emerald-400/50 text-emerald-200'
                : 'bg-amber-950/50 border-amber-400/50 text-amber-200'
            }`}
          >
            {bannerMessage.text}
          </div>
        )}

        {/* Ride List */}
        <div className="p-6 overflow-y-auto synth-scroll flex-1 space-y-3">
          {savedRides.length === 0 ? (
            <div className="rounded-lg border border-cyan-500/25 bg-[#09071d] p-8 text-center space-y-2">
              <div className="font-display text-sm font-bold text-slate-200">
                No completed rides saved yet
              </div>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Finish or end a workout to automatically save the recorded telemetry stream, laps,
                and virtual elevation here for .FIT download or direct Strava upload.
              </p>
            </div>
          ) : (
            savedRides.map((ride) => {
              const distKm = (ride.totalDistanceM / 1000).toFixed(2);
              const isDownloaded = downloadedId === ride.id;
              const isUploading = uploadingId === ride.id;
              const feedback = rideFeedback[ride.id];
              return (
                <div
                  key={ride.id}
                  data-testid="saved-ride-card"
                  className="rounded-lg border border-cyan-500/30 bg-[#0a0820] p-4 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display text-sm sm:text-base font-bold text-white truncate">
                          {ride.activityName ?? ride.workoutName}
                        </h3>
                        {ride.gpsRouteName && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-semibold border border-cyan-500/40 bg-cyan-950/40 text-cyan-200">
                            {ride.gpsRouteName}
                          </span>
                        )}
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider border ${
                            ride.uploadedToStrava
                              ? 'border-emerald-400/50 bg-emerald-950/50 text-emerald-200'
                              : 'border-amber-400/50 bg-amber-950/40 text-amber-200'
                          }`}
                        >
                          {ride.uploadedToStrava ? 'Uploaded to Strava' : 'Pending Strava Upload'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-cyan-300" />
                          {formatRideDate(ride.startTimeMs)}
                        </span>
                        <span>·</span>
                        <span className="text-slate-200 font-semibold">
                          {formatClock(ride.totalTimerSec)}
                        </span>
                        <span>·</span>
                        <span className="text-cyan-300 font-semibold">{distKm} km</span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1 text-pink-300">
                          <Mountain className="w-3.5 h-3.5" />+{ride.totalAscentM} m
                        </span>
                        <span>·</span>
                        <span>{ride.avgPower} W avg</span>
                        {ride.avgHeartRate > 0 && (
                          <>
                            <span>·</span>
                            <span>{ride.avgHeartRate} bpm</span>
                          </>
                        )}
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          <Flag className="w-3 h-3 text-cyan-300" />
                          {ride.laps.length} {ride.laps.length === 1 ? 'lap' : 'laps'}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={isUploading}
                        onClick={() => void handleUploadToStrava(ride)}
                        data-testid="btn-upload-strava"
                        aria-label={`Upload ${ride.activityName ?? ride.workoutName} to Strava`}
                        className={`min-h-[48px] px-4 rounded-md border font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-colors disabled:opacity-60 ${
                          ride.uploadedToStrava
                            ? 'bg-emerald-500/20 border-emerald-400/75 text-emerald-100 hover:bg-emerald-500/30'
                            : 'bg-[#fc4c02]/25 border-[#fc4c02] text-orange-100 hover:bg-[#fc4c02]/40'
                        }`}
                      >
                        {isUploading ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin text-orange-200" />
                            Uploading...
                          </>
                        ) : ride.uploadedToStrava ? (
                          <>
                            <Check className="w-4 h-4 text-emerald-300" />
                            Strava
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 text-[#ff7033]" />
                            Strava
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDownload(ride)}
                        aria-label={`Save FIT for ${ride.workoutName}`}
                        className="min-h-[48px] px-4 rounded-md bg-cyan-500/20 border border-cyan-400/75 text-white hover:bg-cyan-500/35 font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2"
                      >
                        {isDownloaded ? (
                          <>
                            <Check className="w-4 h-4 text-emerald-300" />
                            Saved
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4 text-cyan-300" />
                            Save FIT
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => void deleteSavedRideById(ride.id)}
                        aria-label={`Delete saved ride ${ride.workoutName}`}
                        className="min-w-[48px] min-h-[48px] rounded-md bg-[#160b26] border border-pink-500/40 text-pink-300 hover:bg-pink-500/20 flex items-center justify-center"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {feedback && (
                    <div
                      data-testid="strava-ride-feedback"
                      className={`rounded-md px-3 py-2 text-xs border flex items-center justify-between gap-2 ${
                        feedback.ok
                          ? 'bg-emerald-950/45 border-emerald-400/45 text-emerald-200'
                          : 'bg-pink-950/45 border-pink-400/45 text-pink-200'
                      }`}
                    >
                      <span>{feedback.message}</span>
                      {feedback.activityId && (
                        <a
                          href={`https://www.strava.com/activities/${feedback.activityId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-display font-bold text-orange-300 hover:text-orange-200 shrink-0"
                        >
                          View on Strava
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
