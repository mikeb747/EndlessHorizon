import { clampFreeRideCenterWatts } from '../core/freeRide';
import { formatClock, formatShortDuration } from '../core/zones';
import { getActiveZone, useAppStore } from '../store/useAppStore';

export function TopHud() {
  const heartRate = useAppStore((s) => s.heartRate);
  const power3sAvg = useAppStore((s) => s.power3sAvg);
  const cadence = useAppStore((s) => s.cadence);
  const activeSnapshot = useAppStore((s) => s.activeSnapshot);
  const trainerStatus = useAppStore((s) => s.trainerStatus);
  const hrStatus = useAppStore((s) => s.hrStatus);
  const rideMode = useAppStore((s) => s.rideMode);
  const elapsedSec = useAppStore((s) => s.elapsedSec);
  const ftp = useAppStore((s) => s.ftp);
  const freeRideZone = useAppStore((s) => s.freeRideZone);
  const freeRideOffsetWatts = useAppStore((s) => s.freeRideOffsetWatts);
  const freeRideGrade = useAppStore((s) => s.freeRideGrade);
  const freeRideTargetWatts = useAppStore((s) => s.freeRideTargetWatts);
  const zone = useAppStore(getActiveZone);

  const isFreeRide = rideMode === 'freeride';
  const stepElapsed = activeSnapshot?.stepElapsedSec ?? 0;
  const stepRemaining = activeSnapshot?.stepRemainingSec ?? 0;
  const stepProgress = activeSnapshot?.stepProgress ?? 0;
  const targetWatts = isFreeRide ? freeRideTargetWatts : activeSnapshot?.targetWatts ?? 0;
  const stepDurationLabel = activeSnapshot ? formatShortDuration(activeSnapshot.step.duration) : '0 s';
  const stepLabel = activeSnapshot?.step.label ?? 'Ready';
  const ergLabel = trainerStatus.ergControlActive ? 'ERG ACTIVE' : 'ERG STANDBY';

  const freeRideRange = clampFreeRideCenterWatts(freeRideZone, ftp, freeRideOffsetWatts);
  const zoneSpan = Math.max(1, freeRideRange.maxWatts - freeRideRange.minWatts);
  const freeRideBarPct = Math.max(
    0,
    Math.min(100, ((freeRideTargetWatts - freeRideRange.minWatts) / zoneSpan) * 100)
  );
  const freeRideCenterPct = Math.max(
    0,
    Math.min(100, ((freeRideRange.centerWatts - freeRideRange.minWatts) / zoneSpan) * 100)
  );
  const gradePctVal = freeRideGrade * 100;
  const gradeText =
    Math.abs(gradePctVal) < 0.05
      ? '0.0%'
      : `${gradePctVal > 0 ? '+' : ''}${gradePctVal.toFixed(1)}%`;

  return (
    <header
      className="hud-container neon-frame-hud rounded-lg px-3 sm:px-5 py-2 sm:py-2.5 shrink-0"
      aria-label="Live Ride Telemetry HUD"
    >
      {/* Row 1: Three big readouts — HEART RATE (left), POWER 3s AVG (center largest), CADENCE (right) */}
      <div className="grid grid-cols-3 items-end gap-2 pb-2">
        {/* Heart Rate (Left) */}
        <div className="flex flex-col items-start justify-end min-w-0">
          <span className="text-[11px] sm:text-xs font-bold tracking-[0.16em] text-pink-300/90 uppercase whitespace-nowrap">
            Heart Rate
          </span>
          <div className="flex items-baseline gap-1.5">
            <span
              className="font-display font-extrabold tabular-nums leading-none text-pink-400 text-glow-magenta"
              style={{ fontSize: 'clamp(1.75rem, 4.4cqi, 3.25rem)' }}
              data-testid="hud-hr"
            >
              {hrStatus.status === 'connected' ? heartRate : '--'}
            </span>
            <span className="text-xs sm:text-sm font-semibold text-pink-200/75 uppercase">bpm</span>
          </div>
        </div>

        {/* Power 3s Average (Center — largest focal readout) */}
        <div className="flex flex-col items-center justify-end min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span
              className="font-display font-extrabold tabular-nums leading-none text-white text-glow-cyan"
              style={{ fontSize: 'clamp(2.35rem, 6.2cqi, 4.35rem)' }}
              data-testid="hud-power"
            >
              {power3sAvg}
            </span>
            <span className="text-sm sm:text-base font-display font-bold text-cyan-300">W</span>
          </div>
          <span className="text-[10px] sm:text-xs font-bold tracking-[0.2em] text-cyan-300/90 uppercase mt-0.5 whitespace-nowrap">
            Power · 3s Average
          </span>
        </div>

        {/* Cadence (Right) */}
        <div className="flex flex-col items-end justify-end min-w-0">
          <span className="text-[11px] sm:text-xs font-bold tracking-[0.16em] text-cyan-300/90 uppercase whitespace-nowrap">
            Cadence
          </span>
          <div className="flex items-baseline gap-1.5">
            <span
              className="font-display font-extrabold tabular-nums leading-none text-cyan-300 text-glow-cyan"
              style={{ fontSize: 'clamp(1.75rem, 4.4cqi, 3.25rem)' }}
              data-testid="hud-cadence"
            >
              {cadence}
            </span>
            <span className="text-xs sm:text-sm font-semibold text-cyan-200/75 uppercase">rpm</span>
          </div>
        </div>
      </div>

      {/* Glowing Divider Line */}
      <div
        className="h-[2px] w-full my-1.5"
        style={{
          background:
            'linear-gradient(90deg, rgba(255,42,157,0.85) 0%, rgba(0,240,255,0.95) 50%, rgba(255,42,157,0.85) 100%)',
          boxShadow: '0 0 10px rgba(0,240,255,0.55)',
        }}
      />

      {/* Row 2: Status Strip — Workout Step Progress OR Free Ride Zone & Grade Strip */}
      <div className="grid grid-cols-[minmax(84px,120px)_1fr_minmax(84px,120px)] sm:grid-cols-[140px_1fr_140px] items-center gap-2 sm:gap-4 pt-1">
        {/* Left Metric */}
        <div className="flex flex-col items-start min-w-0">
          <span className="text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase leading-tight">
            {isFreeRide ? 'Ride Time' : 'Step Time Complete'}
          </span>
          <span
            className="font-display text-lg sm:text-2xl font-bold tabular-nums text-cyan-200 leading-tight mt-0.5"
            data-testid="hud-step-elapsed"
          >
            {formatClock(isFreeRide ? elapsedSec : stepElapsed)}
          </span>
        </div>

        {/* Center Details + Progress / Zone-Range Bar */}
        <div className="flex flex-col items-center min-w-0 w-full">
          {isFreeRide ? (
            <>
              <div
                className="w-full text-center text-xs sm:text-sm font-bold tracking-wide truncate"
                data-testid="hud-step-details"
              >
                <span className="text-slate-100">Free Ride</span>
                <span className="mx-1.5 text-slate-500">·</span>
                <span className="font-display" style={{ color: zone.glowHex }}>
                  {zone.code} {zone.shortName} ({freeRideRange.minWatts}–{freeRideRange.maxWatts} W)
                </span>
                <span className="mx-1.5 text-slate-500">·</span>
                <span className="text-slate-100">
                  Target <span className="font-display text-white">{targetWatts} W</span>
                </span>
                <span className="mx-1.5 text-slate-500">·</span>
                <span className={trainerStatus.ergControlActive ? 'text-cyan-300' : 'text-amber-300'}>
                  {ergLabel}
                </span>
              </div>

              {/* Zone Range Position Bar with user mid-range marker */}
              <div
                className="neon-progress-outline relative w-full h-4 sm:h-5 rounded bg-[#070516] overflow-hidden mt-1.5"
                role="progressbar"
                aria-label="Free ride ERG target within zone range"
                aria-valuemin={freeRideRange.minWatts}
                aria-valuemax={freeRideRange.maxWatts}
                aria-valuenow={targetWatts}
                data-testid="hud-freeride-range-bar"
              >
                <div
                  className="h-full transition-[width] duration-300 ease-linear"
                  style={{
                    width: `${freeRideBarPct}%`,
                    backgroundColor: zone.hex,
                    boxShadow: `0 0 14px ${zone.hex}`,
                  }}
                />
                {/* Adjusted mid-range tick marker */}
                <div
                  className="absolute top-0 bottom-0 w-[2px] bg-white shadow-[0_0_6px_#ffffff]"
                  style={{ left: `${freeRideCenterPct}%` }}
                  aria-hidden="true"
                />
                <span className="absolute inset-0 flex items-center justify-between px-2 text-[10px] font-display font-bold tracking-wider text-white/95 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  <span>{freeRideRange.minWatts}W</span>
                  <span>CTR {freeRideRange.centerWatts}W</span>
                  <span>{freeRideRange.maxWatts}W</span>
                </span>
              </div>
            </>
          ) : (
            <>
              <div
                className="w-full text-center text-xs sm:text-sm font-bold tracking-wide truncate"
                data-testid="hud-step-details"
              >
                <span className="text-slate-100">
                  {stepDurationLabel} {stepLabel} @{' '}
                  <span className="font-display text-white">{targetWatts} W</span>
                </span>
                <span className="mx-1.5 text-slate-500">·</span>
                <span className="font-display" style={{ color: zone.glowHex }}>
                  {zone.code} {zone.shortName}
                </span>
                <span className="mx-1.5 text-slate-500">·</span>
                <span className={trainerStatus.ergControlActive ? 'text-cyan-300' : 'text-amber-300'}>
                  {ergLabel}
                </span>
              </div>

              {/* Progress Bar with orange neon outline filling in zone color */}
              <div
                className="neon-progress-outline relative w-full h-4 sm:h-5 rounded bg-[#070516] overflow-hidden mt-1.5"
                role="progressbar"
                aria-label="Current step progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(stepProgress * 100)}
              >
                <div
                  className="h-full transition-[width] duration-300 ease-linear"
                  style={{
                    width: `${Math.max(0, Math.min(100, stepProgress * 100))}%`,
                    backgroundColor: zone.hex,
                    boxShadow: `0 0 14px ${zone.hex}`,
                  }}
                />
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-display font-bold tracking-widest text-white/95 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  {Math.round(stepProgress * 100)}%
                </span>
              </div>
            </>
          )}
        </div>

        {/* Right Metric */}
        <div className="flex flex-col items-end min-w-0">
          <span className="text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase leading-tight text-right">
            {isFreeRide ? 'Road Grade' : 'Step Time Remaining'}
          </span>
          <span
            className="font-display text-lg sm:text-2xl font-bold tabular-nums text-amber-300 leading-tight mt-0.5"
            data-testid={isFreeRide ? 'hud-freeride-grade' : 'hud-step-remaining'}
          >
            {isFreeRide ? gradeText : formatClock(stepRemaining)}
          </span>
        </div>
      </div>
    </header>
  );
}
