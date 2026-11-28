import { useMemo } from 'react';
import type { NormalizedPoint } from '../recording/lineArtTracer';

interface GpsSampleLike {
  latDeg: number;
  lonDeg: number;
}

interface GpsRoutePreviewSvgProps {
  /** Normalized 2D path (East = +X, North = +Y) for route preview / live HUD mini-map */
  points?: readonly NormalizedPoint[];
  /** Actual recorded GPS samples (lat/lon) — projected conformally 1:1 with cos(avgLat) */
  gpsRecords?: readonly GpsSampleLike[];
  /** Optional 0..1 completion progress along the path (draws glowing ridden segment + rider dot) */
  progress01?: number;
  height?: number;
  strokeColor?: string;
  tracedColor?: string;
  className?: string;
  label?: string;
}

function projectToSvgCoords(
  rawPoints: readonly NormalizedPoint[],
  width: number,
  height: number,
  pad: number
): Array<{ sx: number; sy: number }> {
  if (rawPoints.length < 2) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const availW = Math.max(10, width - pad * 2);
  const availH = Math.max(10, height - pad * 2);
  const scale = Math.min(availW / spanX, availH / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  const offsetX = (width - drawW) * 0.5;
  const offsetY = (height - drawH) * 0.5;

  const out: Array<{ sx: number; sy: number }> = new Array(rawPoints.length);
  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    // Flip Y so North (+Y) renders UP on screen
    out[i] = {
      sx: offsetX + (p.x - minX) * scale,
      sy: offsetY + (maxY - p.y) * scale,
    };
  }
  return out;
}

function buildPolylineString(coords: ReadonlyArray<{ sx: number; sy: number }>): string {
  return coords.map((c) => `${c.sx.toFixed(1)},${c.sy.toFixed(1)}`).join(' ');
}

export function GpsRoutePreviewSvg({
  points,
  gpsRecords,
  progress01,
  height = 96,
  strokeColor = '#00f0ff',
  tracedColor = '#ff2a9d',
  className = '',
  label = 'GPS Route Plot',
}: GpsRoutePreviewSvgProps) {
  const viewW = 280;
  const viewH = Math.max(64, Math.round((height / 96) * 116));

  const { fullPathStr, tracedPathStr, riderDot, startDot } = useMemo(() => {
    let source: NormalizedPoint[] = [];

    if (gpsRecords && gpsRecords.length >= 2) {
      let avgLat = 0;
      for (let i = 0; i < gpsRecords.length; i++) avgLat += gpsRecords[i].latDeg;
      avgLat /= gpsRecords.length;
      const cosLat = Math.cos((avgLat * Math.PI) / 180);

      // Decimate very long rides (>400 samples) for crisp lightweight SVG rendering
      const step = Math.max(1, Math.floor(gpsRecords.length / 400));
      for (let i = 0; i < gpsRecords.length; i += step) {
        source.push({
          x: gpsRecords[i].lonDeg * cosLat,
          y: gpsRecords[i].latDeg,
        });
      }
      const last = gpsRecords[gpsRecords.length - 1];
      source.push({ x: last.lonDeg * cosLat, y: last.latDeg });
    } else if (points && points.length >= 2) {
      source = points as NormalizedPoint[];
    }

    const coords = projectToSvgCoords(source, viewW, viewH, 10);
    if (coords.length < 2) {
      return {
        fullPathStr: '',
        tracedPathStr: '',
        riderDot: null as { sx: number; sy: number } | null,
        startDot: null as { sx: number; sy: number } | null,
      };
    }

    const fullStr = buildPolylineString(coords);
    let tracedStr = '';
    let dot: { sx: number; sy: number } | null = null;

    if (typeof progress01 === 'number' && Number.isFinite(progress01)) {
      const clamped = Math.max(0, Math.min(1, progress01));
      // Measure cumulative SVG arc length so dot moves smoothly at exact physical pace
      const cum = new Float64Array(coords.length);
      for (let i = 1; i < coords.length; i++) {
        cum[i] =
          cum[i - 1] +
          Math.hypot(coords[i].sx - coords[i - 1].sx, coords[i].sy - coords[i - 1].sy);
      }
      const total = Math.max(1e-6, cum[coords.length - 1]);
      const targetLen = clamped * total;

      const partial: Array<{ sx: number; sy: number }> = [coords[0]];
      dot = coords[0];
      for (let i = 1; i < coords.length; i++) {
        if (cum[i] <= targetLen) {
          partial.push(coords[i]);
          dot = coords[i];
        } else {
          const seg = cum[i] - cum[i - 1];
          const t = seg > 1e-6 ? (targetLen - cum[i - 1]) / seg : 0;
          const interp = {
            sx: coords[i - 1].sx + (coords[i].sx - coords[i - 1].sx) * t,
            sy: coords[i - 1].sy + (coords[i].sy - coords[i - 1].sy) * t,
          };
          partial.push(interp);
          dot = interp;
          break;
        }
      }
      tracedStr = buildPolylineString(partial);
    }

    return {
      fullPathStr: fullStr,
      tracedPathStr: tracedStr,
      riderDot: dot,
      startDot: coords[0],
    };
  }, [points, gpsRecords, progress01, viewW, viewH]);

  if (!fullPathStr) {
    return (
      <div
        className={`flex items-center justify-center rounded border border-cyan-500/20 bg-[#060414]/80 text-[11px] text-slate-400 ${className}`}
        style={{ height }}
      >
        No GPS route track yet
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      width="100%"
      height={height}
      role="img"
      aria-label={label}
      className={`block ${className}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Subtle synthwave coordinate grid */}
      <line x1="0" y1={viewH * 0.5} x2={viewW} y2={viewH * 0.5} stroke="rgba(0,240,255,0.08)" strokeWidth="1" />
      <line x1={viewW * 0.5} y1="0" x2={viewW * 0.5} y2={viewH} stroke="rgba(0,240,255,0.08)" strokeWidth="1" />

      {/* Full route glow + crisp line */}
      <polyline
        points={fullPathStr}
        fill="none"
        stroke={strokeColor}
        strokeOpacity={tracedPathStr ? 0.28 : 0.3}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points={fullPathStr}
        fill="none"
        stroke={strokeColor}
        strokeOpacity={tracedPathStr ? 0.55 : 0.95}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Completed / ridden progress highlight */}
      {tracedPathStr && (
        <>
          <polyline
            points={tracedPathStr}
            fill="none"
            stroke={tracedColor}
            strokeOpacity={0.4}
            strokeWidth="5.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points={tracedPathStr}
            fill="none"
            stroke={tracedColor}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}

      {/* Start marker */}
      {startDot && (
        <circle
          cx={startDot.sx}
          cy={startDot.sy}
          r="2.8"
          fill="#22d3ee"
          stroke="#060414"
          strokeWidth="1"
        />
      )}

      {/* Live rider dot */}
      {riderDot && (
        <>
          <circle cx={riderDot.sx} cy={riderDot.sy} r="6.5" fill={tracedColor} fillOpacity="0.35" />
          <circle
            cx={riderDot.sx}
            cy={riderDot.sy}
            r="3.6"
            fill="#ffffff"
            stroke={tracedColor}
            strokeWidth="1.8"
          />
        </>
      )}
    </svg>
  );
}
