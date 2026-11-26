import { getPowerZone, getTargetWatts } from '../core/zones';
import { ParsedWorkout } from '../core/zwoParser';

interface MiniProfileChartProps {
  workout: ParsedWorkout;
  ftp: number;
  intensityOffsetPct?: number;
  height?: number;
  elapsedSec?: number;
}

export function MiniProfileChart({
  workout,
  ftp,
  intensityOffsetPct = 0,
  height = 72,
  elapsedSec,
}: MiniProfileChartProps) {
  const total = Math.max(1, workout.totalDuration);
  const maxFrac = Math.max(
    1.35,
    ...workout.timeline.map((s) => Math.max(s.powerLow, s.powerHigh))
  );

  const viewW = 480;
  const viewH = height;

  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      preserveAspectRatio="none"
      className="w-full block rounded overflow-hidden bg-[#070516] border border-cyan-500/25"
      style={{ height }}
      role="img"
      aria-label={`${workout.name} power profile`}
    >
      {/* 100% FTP reference dashed line */}
      <line
        x1={0}
        x2={viewW}
        y1={viewH - (1.0 / maxFrac) * (viewH - 6)}
        y2={viewH - (1.0 / maxFrac) * (viewH - 6)}
        stroke="rgba(255,255,255,0.22)"
        strokeDasharray="4 4"
        strokeWidth={1}
      />

      {workout.timeline.map((step) => {
        const x1 = (step.startTime / total) * viewW;
        const x2 = (step.endTime / total) * viewW;
        const y1 = viewH - (step.powerLow / maxFrac) * (viewH - 6);
        const y2 = viewH - (step.powerHigh / maxFrac) * (viewH - 6);
        const avgFrac = (step.powerLow + step.powerHigh) / 2;
        const zone = getPowerZone(avgFrac);
        const watts = getTargetWatts(avgFrac, ftp, intensityOffsetPct);

        return (
          <polygon
            key={step.id}
            points={`${x1},${viewH} ${x1},${y1} ${x2},${y2} ${x2},${viewH}`}
            fill={zone.hex}
            fillOpacity={0.78}
            stroke="rgba(6,4,18,0.45)"
            strokeWidth={0.5}
          >
            <title>
              {step.label}: {watts} W ({zone.code} {zone.name})
            </title>
          </polygon>
        );
      })}

      {typeof elapsedSec === 'number' && elapsedSec > 0 && (
        <line
          x1={(elapsedSec / total) * viewW}
          x2={(elapsedSec / total) * viewW}
          y1={0}
          y2={viewH}
          stroke="#ffffff"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}
