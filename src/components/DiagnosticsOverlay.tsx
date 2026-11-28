import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { getRecordingDiagnostics, useAppStore } from '../store/useAppStore';
import { graphicsGovernor } from '../world/graphicsGovernor';

interface DiagnosticsSnapshot {
  frameTimeMs: number;
  longTaskCount: number;
  maxSampleGapMs: number;
  ergWriteLatencyMs: number | null;
  degradationStage: number;
  fpsCap: number;
  activeDegradations: string;
}

/**
 * Optional live diagnostics HUD overlay showing frame time, long-task count,
 * largest gap between recorded 1 Hz samples, and time from step change to ERG write.
 */
export function DiagnosticsOverlay() {
  const minimalMode = useAppStore((s) => s.minimalMode);
  const quality = useAppStore((s) => s.quality);
  const qualityOverride = useAppStore((s) => s.qualityOverride);

  const [snap, setSnap] = useState<DiagnosticsSnapshot>({
    frameTimeMs: 16.6,
    longTaskCount: 0,
    maxSampleGapMs: 0,
    ergWriteLatencyMs: null,
    degradationStage: 0,
    fpsCap: 60,
    activeDegradations: 'None',
  });

  useEffect(() => {
    const poll = () => {
      const gov = graphicsGovernor.getDiagnostics(false);
      const rec = getRecordingDiagnostics();
      setSnap({
        frameTimeMs: gov.emaFrameTimeMs,
        longTaskCount: gov.longTaskCount,
        maxSampleGapMs: rec.maxSampleGapMs,
        ergWriteLatencyMs: rec.lastErgWriteLatencyMs,
        degradationStage: gov.degradationStage,
        fpsCap: gov.fpsCap,
        activeDegradations:
          gov.activeDegradations.length > 0 ? gov.activeDegradations.join(' → ') : 'Full',
      });
    };

    poll();
    const id = window.setInterval(poll, 500);
    return () => window.clearInterval(id);
  }, []);

  const gapOk = snap.maxSampleGapMs <= 1500;
  const ergOk = snap.ergWriteLatencyMs === null || snap.ergWriteLatencyMs <= 250;

  return (
    <aside
      className="pointer-events-none fixed bottom-20 left-3 z-40 rounded-lg border border-cyan-400/55 bg-[#070517]/92 px-3 py-2 text-[11px] font-mono text-slate-200 shadow-[0_0_18px_rgba(0,240,255,0.22)] min-w-[230px]"
      data-testid="diagnostics-overlay"
      aria-label="Performance diagnostics"
    >
      <div className="flex items-center justify-between gap-2 pb-1 mb-1 border-b border-cyan-500/25 font-display text-[10px] tracking-[0.14em] text-cyan-300 uppercase">
        <span className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-pink-300" />
          Diagnostics
        </span>
        <span className="text-slate-400">
          {minimalMode ? 'MINIMAL' : `${quality.toUpperCase()}${qualityOverride ? '' : ' AUTO'}`}
        </span>
      </div>

      <div className="space-y-0.5 tabular-nums">
        <div className="flex justify-between gap-3">
          <span className="text-slate-400">Frame Time:</span>
          <span className={snap.frameTimeMs > 25 ? 'text-amber-300 font-bold' : 'text-cyan-200'}>
            {minimalMode ? 'HUD-Only' : `${snap.frameTimeMs.toFixed(1)} ms (${snap.fpsCap} cap)`}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-400">Long Tasks:</span>
          <span className={snap.longTaskCount > 0 ? 'text-amber-300' : 'text-emerald-300'}>
            {snap.longTaskCount}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-400">Max Rec Gap:</span>
          <span className={gapOk ? 'text-emerald-300' : 'text-pink-300 font-bold'}>
            {snap.maxSampleGapMs} ms
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-400">Step → ERG:</span>
          <span className={ergOk ? 'text-emerald-300' : 'text-pink-300 font-bold'}>
            {snap.ergWriteLatencyMs !== null ? `${snap.ergWriteLatencyMs} ms` : '--'}
          </span>
        </div>
        {!minimalMode && (
          <div className="flex justify-between gap-3 pt-0.5 border-t border-cyan-500/15 text-[10px]">
            <span className="text-slate-400">Governor:</span>
            <span className="text-cyan-200 truncate max-w-[140px]">
              S{snap.degradationStage} · {snap.activeDegradations}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
