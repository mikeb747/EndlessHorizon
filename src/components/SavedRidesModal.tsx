import { useState } from 'react';
import {
  Check,
  Clock,
  Download,
  Flag,
  FolderArchive,
  Mountain,
  Trash2,
  X,
} from 'lucide-react';
import { formatClock } from '../core/zones';
import { downloadRideFitFile } from '../recording/rideStorage';
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

export function SavedRidesModal() {
  const savedRides = useAppStore((s) => s.savedRides);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const deleteSavedRideById = useAppStore((s) => s.deleteSavedRideById);

  const [downloadedId, setDownloadedId] = useState<string | null>(null);

  const handleDownload = (ride: SavedRide) => {
    downloadRideFitFile(ride);
    setDownloadedId(ride.id);
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
          <div className="flex items-center gap-3">
            <FolderArchive className="w-6 h-6 text-cyan-300 shrink-0" />
            <div>
              <h2
                id="saved-rides-title"
                className="font-display text-lg font-extrabold text-white tracking-wide"
              >
                Saved Completed Rides
              </h2>
              <p className="text-xs text-slate-400">
                Stored locally for Garmin .FIT export and future Strava upload (Virtual Cycling ·
                Ura-shima GPS)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setActiveModal(null)}
            aria-label="Close saved rides"
            className="min-w-[48px] min-h-[48px] rounded-md bg-[#110e2d] border border-cyan-500/40 text-slate-200 hover:bg-cyan-500/20 flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Ride List */}
        <div className="p-6 overflow-y-auto synth-scroll flex-1 space-y-3">
          {savedRides.length === 0 ? (
            <div className="rounded-lg border border-cyan-500/25 bg-[#09071d] p-8 text-center space-y-2">
              <div className="font-display text-sm font-bold text-slate-200">
                No completed rides saved yet
              </div>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Finish or end a workout to automatically save the recorded telemetry stream, laps,
                and virtual elevation here for .FIT download or later Strava upload.
              </p>
            </div>
          ) : (
            savedRides.map((ride) => {
              const distKm = (ride.totalDistanceM / 1000).toFixed(2);
              const isDownloaded = downloadedId === ride.id;
              return (
                <div
                  key={ride.id}
                  data-testid="saved-ride-card"
                  className="rounded-lg border border-cyan-500/30 bg-[#0a0820] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-sm sm:text-base font-bold text-white truncate">
                        {ride.workoutName}
                      </h3>
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

                  <div className="flex items-center gap-2 shrink-0">
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
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
