import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { clampFreeRideCenterWatts } from '../core/freeRide';
import { COGGAN_ZONES, formatClock, getPowerZone, getTargetWatts } from '../core/zones';
import { useAppStore } from '../store/useAppStore';

export function HistoryGraph() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const history = useAppStore((s) => s.history);
  const elapsedSec = useAppStore((s) => s.elapsedSec);
  const ftp = useAppStore((s) => s.ftp);
  const intensityOffsetPct = useAppStore((s) => s.intensityOffsetPct);
  const rideMode = useAppStore((s) => s.rideMode);
  const freeRideZone = useAppStore((s) => s.freeRideZone);
  const freeRideOffsetWatts = useAppStore((s) => s.freeRideOffsetWatts);
  const toggleGraph = useAppStore((s) => s.toggleGraph);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(100, Math.floor(rect.width));
      const height = Math.max(80, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);

      // Clear obsidian backdrop
      ctx.fillStyle = '#070517';
      ctx.fillRect(0, 0, width, height);

      const padLeft = 44;
      const padRight = 44;
      const padTop = 12;
      const padBottom = 22;
      const plotW = Math.max(20, width - padLeft - padRight);
      const plotH = Math.max(20, height - padTop - padBottom);

      const isFreeRide = rideMode === 'freeride';
      const freeRideRange = clampFreeRideCenterWatts(freeRideZone, ftp, freeRideOffsetWatts);
      const totalSec = isFreeRide
        ? Math.max(120, Math.ceil((elapsedSec + 20) / 30) * 30)
        : Math.max(60, activeWorkout.totalDuration);

      // Determine Power Y-axis ceiling (at least 1.5x effective FTP or peak actual power)
      const peakTarget = isFreeRide
        ? Math.max(freeRideRange.maxWatts * 1.15, ftp * 1.4)
        : Math.max(
            ...activeWorkout.timeline.map((s) =>
              Math.max(
                getTargetWatts(s.powerLow, ftp, intensityOffsetPct),
                getTargetWatts(s.powerHigh, ftp, intensityOffsetPct)
              )
            ),
            ftp * 1.4
          );
      const peakHistoryPower = history.reduce((m, h) => Math.max(m, h.power, h.targetWatts), 0);
      const maxWatts = Math.ceil(Math.max(peakTarget, peakHistoryPower, 300) / 50) * 50 + 25;

      const minHr = 50;
      const maxHr = 200;

      const xForSec = (sec: number) => padLeft + (Math.min(totalSec, Math.max(0, sec)) / totalSec) * plotW;
      const yForWatts = (w: number) => padTop + plotH - (Math.min(maxWatts, Math.max(0, w)) / maxWatts) * plotH;
      const yForHr = (hr: number) =>
        padTop + plotH - ((Math.min(maxHr, Math.max(minHr, hr)) - minHr) / (maxHr - minHr)) * plotH;

      // Subtle horizontal grid & dual Y-axis ticks
      ctx.font = '600 10px Orbitron, sans-serif';
      const gridRows = 4;
      for (let i = 0; i <= gridRows; i++) {
        const frac = i / gridRows;
        const y = padTop + plotH - frac * plotH;

        ctx.strokeStyle = 'rgba(0, 240, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
        ctx.stroke();

        // Left Power axis labels (Watts)
        const wVal = Math.round(frac * maxWatts);
        ctx.fillStyle = 'rgba(120, 235, 255, 0.78)';
        ctx.textAlign = 'right';
        ctx.fillText(`${wVal}`, padLeft - 6, y + 3);

        // Right HR axis labels (BPM)
        const hrVal = Math.round(minHr + frac * (maxHr - minHr));
        ctx.fillStyle = 'rgba(255, 130, 195, 0.78)';
        ctx.textAlign = 'left';
        ctx.fillText(`${hrVal}`, padLeft + plotW + 6, y + 3);
      }

      // Render either the selected Free Ride zone band OR filled workout target-power profile
      if (isFreeRide) {
        const zoneInfo = COGGAN_ZONES[freeRideZone];
        const yTop = yForWatts(freeRideRange.maxWatts);
        const yBot = yForWatts(freeRideRange.minWatts);
        const yMid = yForWatts(freeRideRange.centerWatts);

        ctx.fillStyle = zoneInfo.hex;
        ctx.globalAlpha = 0.2;
        ctx.fillRect(padLeft, yTop, plotW, Math.max(2, yBot - yTop));

        ctx.globalAlpha = 0.65;
        ctx.strokeStyle = zoneInfo.hex;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(padLeft, yTop);
        ctx.lineTo(padLeft + plotW, yTop);
        ctx.moveTo(padLeft, yBot);
        ctx.lineTo(padLeft + plotW, yBot);
        ctx.stroke();

        // User-adjusted center line
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = zoneInfo.glowHex;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padLeft, yMid);
        ctx.lineTo(padLeft + plotW, yMid);
        ctx.stroke();
        ctx.restore();

        // Dashed historical ERG target power trace
        if (history.length > 0) {
          ctx.save();
          ctx.setLineDash([5, 3]);
          ctx.strokeStyle = '#ffd166';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          let prevT = -999;
          history.forEach((pt, i) => {
            const x = xForSec(pt.timeSec);
            const y = yForWatts(pt.targetWatts);
            if (i === 0 || Math.abs(pt.timeSec - prevT) > 5) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            prevT = pt.timeSec;
          });
          ctx.stroke();
          ctx.restore();
        }
      } else {
        for (const step of activeWorkout.timeline) {
          const x1 = xForSec(step.startTime);
          const x2 = xForSec(step.endTime);
          const wLow = getTargetWatts(step.powerLow, ftp, intensityOffsetPct);
          const wHigh = getTargetWatts(step.powerHigh, ftp, intensityOffsetPct);
          const y1 = yForWatts(wLow);
          const y2 = yForWatts(wHigh);
          const avgFrac = (step.powerLow + step.powerHigh) / 2;
          const zone = getPowerZone(avgFrac);

          ctx.beginPath();
          ctx.moveTo(x1, padTop + plotH);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x2, padTop + plotH);
          ctx.closePath();

          ctx.fillStyle = zone.hex;
          ctx.globalAlpha = step.endTime <= elapsedSec ? 0.36 : 0.24;
          ctx.fill();

          // Crisp top edge of target profile
          ctx.globalAlpha = 0.72;
          ctx.strokeStyle = zone.hex;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // FTP dashed horizontal reference line
      const effFtp = Math.round(ftp * (1 + intensityOffsetPct / 100));
      const yFtp = yForWatts(effFtp);
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, yFtp);
      ctx.lineTo(padLeft + plotW, yFtp);
      ctx.stroke();
      ctx.restore();

      // Actual Power Line (Electric Cyan) — break trace cleanly if user skipped steps
      if (history.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.4;
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        let prevTime = -999;
        history.forEach((pt, i) => {
          const x = xForSec(pt.timeSec);
          const y = yForWatts(pt.power);
          if (i === 0 || Math.abs(pt.timeSec - prevTime) > 5) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          prevTime = pt.timeSec;
        });
        ctx.stroke();
        ctx.restore();

        // Actual Heart Rate Line (Neon Magenta)
        ctx.save();
        ctx.strokeStyle = '#ff2a9d';
        ctx.lineWidth = 2.2;
        ctx.shadowColor = '#ff2a9d';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        let startedHr = false;
        let prevHrTime = -999;
        history.forEach((pt) => {
          if (pt.heartRate <= 0) return;
          const x = xForSec(pt.timeSec);
          const y = yForHr(pt.heartRate);
          if (!startedHr || Math.abs(pt.timeSec - prevHrTime) > 5) {
            ctx.moveTo(x, y);
            startedHr = true;
          } else {
            ctx.lineTo(x, y);
          }
          prevHrTime = pt.timeSec;
        });
        ctx.stroke();
        ctx.restore();
      }

      // Vertical "NOW" cursor line
      const nowX = xForSec(elapsedSec);
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(nowX, padTop);
      ctx.lineTo(nowX, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      // Bottom time axis ticks
      ctx.fillStyle = 'rgba(180, 200, 230, 0.72)';
      ctx.font = '600 10px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      const tickCount = 6;
      for (let i = 0; i <= tickCount; i++) {
        const sec = Math.round((i / tickCount) * totalSec);
        ctx.fillText(formatClock(sec), xForSec(sec), height - 5);
      }

      ctx.restore();
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [activeWorkout, history, elapsedSec, ftp, intensityOffsetPct, rideMode, freeRideZone, freeRideOffsetWatts]);

  return (
    <section
      className="neon-frame-cyan rounded-lg flex flex-col shrink-0 overflow-hidden h-[clamp(145px,19vh,252px)]"
      aria-label="Power and Heart Rate History Graph"
      data-testid="history-graph-section"
    >
      <div className="flex items-center justify-between px-3 py-1 border-b border-cyan-500/25 shrink-0 bg-[#0a0820]">
        <div className="flex items-center gap-4 text-xs font-semibold">
          <span className="font-display text-[11px] tracking-[0.14em] text-cyan-300 uppercase">
            Telemetry Graph
          </span>
          <span className="text-cyan-300">Power (W)</span>
          <span className="text-pink-400">Heart Rate (BPM)</span>
          <span className="hidden sm:inline text-slate-400">
            {rideMode === 'freeride' ? 'ERG Target & Zone Band' : 'Target Profile (Zone)'}
          </span>
        </div>

        <button
          type="button"
          onClick={toggleGraph}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-cyan-200 hover:text-white rounded hover:bg-cyan-500/15 transition-colors whitespace-nowrap"
          aria-label="Hide history graph"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          Hide Graph (G)
        </button>
      </div>

      <div ref={containerRef} className="relative flex-1 min-h-0 w-full">
        <canvas
          ref={canvasRef}
          className="block w-full h-full"
          data-testid="history-graph-canvas"
        />
      </div>
    </section>
  );
}
