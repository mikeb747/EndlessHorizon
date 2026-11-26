import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Flame,
  ListChecks,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Zap,
} from 'lucide-react';
import { clampFreeRideCenterWatts, FREE_RIDE_WATT_STEP, getZoneWattRange } from '../core/freeRide';
import {
  COGGAN_ZONES,
  formatClock,
  formatShortDuration,
  getPowerZone,
  getTargetWatts,
  ZoneNumber,
} from '../core/zones';
import { RepeatGroupNode, SingleStepNode, WorkoutTreeNode } from '../core/zwoParser';
import { useAppStore } from '../store/useAppStore';

const ALL_ZONES: ZoneNumber[] = [1, 2, 3, 4, 5, 6, 7];

function formatTimeOfDay(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function StepWattsLabel({
  powerLow,
  powerHigh,
  ftp,
  offsetPct,
}: {
  powerLow: number;
  powerHigh: number;
  ftp: number;
  offsetPct: number;
}) {
  const lowW = getTargetWatts(powerLow, ftp, offsetPct);
  const highW = getTargetWatts(powerHigh, ftp, offsetPct);
  if (Math.abs(lowW - highW) <= 1) {
    return <span className="font-display tabular-nums font-bold text-white">{lowW} W</span>;
  }
  return (
    <span className="font-display tabular-nums font-bold text-white">
      {lowW}–{highW} W
    </span>
  );
}

interface LeftPanelContentProps {
  onStepClick?: () => void;
}

function LeftPanelContent({ onStepClick }: LeftPanelContentProps) {
  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const activeSnapshot = useAppStore((s) => s.activeSnapshot);
  const elapsedSec = useAppStore((s) => s.elapsedSec);
  const ftp = useAppStore((s) => s.ftp);
  const intensityOffsetPct = useAppStore((s) => s.intensityOffsetPct);
  const liveTss = useAppStore((s) => s.liveTss);
  const calories = useAppStore((s) => s.calories);
  const rideMode = useAppStore((s) => s.rideMode);
  const rideDistanceM = useAppStore((s) => s.rideDistanceM);
  const freeRideZone = useAppStore((s) => s.freeRideZone);
  const freeRideOffsetWatts = useAppStore((s) => s.freeRideOffsetWatts);
  const freeRideTargetWatts = useAppStore((s) => s.freeRideTargetWatts);
  const jumpToStep = useAppStore((s) => s.jumpToStep);
  const setFreeRideZone = useAppStore((s) => s.setFreeRideZone);
  const adjustFreeRideWatts = useAppStore((s) => s.adjustFreeRideWatts);
  const resetFreeRideOffset = useAppStore((s) => s.resetFreeRideOffset);

  const isFreeRide = rideMode === 'freeride';
  const freeRideRange = clampFreeRideCenterWatts(freeRideZone, ftp, freeRideOffsetWatts);

  const [nowText, setNowText] = useState(() => formatTimeOfDay(new Date()));
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const activeItemRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowText(formatTimeOfDay(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);

  const currentStepIndex = activeSnapshot?.stepIndex ?? 0;
  const currentStepProgress = activeSnapshot?.stepProgress ?? 0;
  const remainingTotal = Math.max(0, activeWorkout.totalDuration - elapsedSec);

  // Auto-scroll active step into view whenever stepIndex changes
  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentStepIndex]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const renderSingleStep = (node: SingleStepNode) => {
    const isDone = currentStepIndex > node.stepIndex;
    const isActive = currentStepIndex === node.stepIndex;
    const avgPower = (node.powerLow + node.powerHigh) / 2;
    const zone = getPowerZone(avgPower);

    return (
      <div
        key={node.id}
        ref={isActive ? activeItemRef : undefined}
        className={`rounded-md border transition-colors ${
          isActive
            ? 'bg-cyan-950/55 border-cyan-400/80'
            : isDone
              ? 'bg-[#09081b]/55 border-slate-800/70 opacity-55'
              : 'bg-[#0b0920]/75 border-slate-700/50 hover:border-cyan-500/45'
        }`}
      >
        <button
          type="button"
          onClick={() => {
            jumpToStep(node.stepIndex);
            onStepClick?.();
          }}
          className="w-full text-left px-2.5 py-2 min-h-[44px] flex flex-col gap-1 focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          <div className="flex items-center justify-between gap-2 text-xs leading-snug">
            <div className="flex items-center gap-1.5 min-w-0">
              {isDone ? (
                <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
              ) : (
                <span
                  className="w-2 h-2 rounded-xs shrink-0"
                  style={{ backgroundColor: zone.hex }}
                  aria-hidden="true"
                />
              )}
              <span className={`font-semibold truncate ${isActive ? 'text-white' : 'text-slate-200'}`}>
                {formatShortDuration(node.duration)} {node.label}
              </span>
            </div>
            <span className="shrink-0 text-[11px] text-slate-300">
              @{' '}
              <StepWattsLabel
                powerLow={node.powerLow}
                powerHigh={node.powerHigh}
                ftp={ftp}
                offsetPct={intensityOffsetPct}
              />
            </span>
          </div>

          {isActive && (
            <div className="w-full h-1.5 rounded-full bg-slate-900/90 overflow-hidden mt-0.5">
              <div
                className="h-full transition-[width] duration-300"
                style={{
                  width: `${Math.round(currentStepProgress * 100)}%`,
                  backgroundColor: zone.hex,
                }}
              />
            </div>
          )}
        </button>
      </div>
    );
  };

  const renderRepeatGroup = (node: RepeatGroupNode) => {
    const isGroupDone = currentStepIndex > node.lastStepIndex;
    const isGroupActive =
      currentStepIndex >= node.firstStepIndex && currentStepIndex <= node.lastStepIndex;
    const isCollapsed = !!collapsedGroups[node.id];

    const currentRepeat = isGroupActive ? activeSnapshot?.step.repeatIndex ?? 1 : null;
    const activeChildIdx = isGroupActive ? activeSnapshot?.step.stepInRepeat ?? 0 : -1;

    return (
      <div
        key={node.id}
        ref={isGroupActive ? activeItemRef : undefined}
        className={`rounded-md border transition-colors ${
          isGroupActive
            ? 'bg-[#130d2e]/85 border-pink-400/80'
            : isGroupDone
              ? 'bg-[#09081b]/55 border-slate-800/70 opacity-55'
              : 'bg-[#0b0920]/75 border-slate-700/50'
        }`}
      >
        {/* Group Header Row */}
        <div className="flex items-center justify-between gap-1 px-2 py-1.5 min-h-[44px]">
          <button
            type="button"
            onClick={() => toggleGroup(node.id)}
            aria-expanded={!isCollapsed}
            className="flex items-center gap-1.5 text-left min-w-0 flex-1 py-1 focus-visible:outline-2 focus-visible:outline-cyan-400"
          >
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4 text-cyan-300 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-4 h-4 text-cyan-300 shrink-0" aria-hidden="true" />
            )}
            {isGroupDone && (
              <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
            )}
            <span className="font-display text-xs font-bold text-pink-300 shrink-0">
              {node.repeat}×
            </span>
            <span className="text-xs font-semibold text-slate-100 truncate">
              {node.label}
            </span>
          </button>

          {isGroupActive && currentRepeat !== null ? (
            <span className="font-display text-xs font-bold tabular-nums text-cyan-300 shrink-0 px-1.5">
              {currentRepeat}/{node.repeat}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                jumpToStep(node.firstStepIndex);
                onStepClick?.();
              }}
              className="text-[11px] font-semibold text-cyan-300/80 hover:text-cyan-200 px-1.5 py-1 shrink-0"
              aria-label={`Jump to ${node.label}`}
            >
              {formatShortDuration(node.totalDuration)}
            </button>
          )}
        </div>

        {/* Nested Child Steps inside { ... } */}
        {!isCollapsed && (
          <div className="pl-5 pr-2.5 pb-2 space-y-1.5">
            {node.childrenTemplate.map((child, idx) => {
              const childZone = getPowerZone(child.powerLow);
              const isChildActive = isGroupActive && activeChildIdx === idx;
              const targetStepIdx = isGroupActive
                ? node.firstStepIndex + ((currentRepeat ?? 1) - 1) * 2 + idx
                : node.firstStepIndex + idx;

              return (
                <button
                  key={`${node.id}-tpl-${idx}`}
                  type="button"
                  onClick={() => {
                    jumpToStep(targetStepIdx);
                    onStepClick?.();
                  }}
                  className={`w-full text-left rounded px-2 py-1.5 border transition-colors ${
                    isChildActive
                      ? 'bg-[#1c1340] border-cyan-400/80'
                      : 'bg-[#080719]/80 border-slate-800/80 hover:border-cyan-500/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-xs shrink-0"
                        style={{ backgroundColor: childZone.hex }}
                        aria-hidden="true"
                      />
                      <span className="font-semibold text-slate-200 truncate">
                        {formatShortDuration(child.duration)} {child.label}
                      </span>
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-300">
                      @{' '}
                      <StepWattsLabel
                        powerLow={child.powerLow}
                        powerHigh={child.powerHigh}
                        ftp={ftp}
                        offsetPct={intensityOffsetPct}
                      />
                    </span>
                  </div>

                  {isChildActive && (
                    <div className="w-full h-1.5 rounded-full bg-slate-900 mt-1.5 overflow-hidden">
                      <div
                        className="h-full transition-[width] duration-300"
                        style={{
                          width: `${Math.round(currentStepProgress * 100)}%`,
                          backgroundColor: childZone.hex,
                        }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {/* Box 1: Stats Box (Current Time of Day, TSS, Calories, Elapsed Time, Remaining Time) */}
      <section
        className="neon-frame-cyan rounded-lg px-3 py-2 shrink-0 space-y-1.5"
        aria-label="Session Statistics"
      >
        <div className="flex items-center justify-between border-b border-cyan-500/25 pb-1">
          <span className="text-[11px] font-bold tracking-[0.14em] text-cyan-300/90 uppercase">
            Time of Day
          </span>
          <span className="font-display text-sm sm:text-base font-bold tabular-nums text-white" data-testid="stats-clock">
            {nowText}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
              TSS
            </div>
            <div className="font-display text-base sm:text-lg font-bold tabular-nums text-cyan-200 leading-tight" data-testid="stats-tss">
              {liveTss.toFixed(1)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
              Calories
            </div>
            <div className="font-display text-base sm:text-lg font-bold tabular-nums text-pink-300 leading-tight" data-testid="stats-calories">
              {calories} <span className="text-[11px] font-sans text-pink-200/75">kcal</span>
            </div>
          </div>
        </div>

        <div className="space-y-0.5 border-t border-cyan-500/20 pt-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold tracking-[0.1em] text-slate-400 uppercase">Elapsed Time</span>
            <span className="font-display text-sm font-bold tabular-nums text-slate-100" data-testid="stats-elapsed">
              {formatClock(elapsedSec)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold tracking-[0.1em] text-slate-400 uppercase">
              {isFreeRide ? 'Distance' : 'Remaining Time'}
            </span>
            <span className="font-display text-sm font-bold tabular-nums text-amber-300" data-testid="stats-remaining">
              {isFreeRide ? `${(rideDistanceM / 1000).toFixed(2)} km` : formatClock(remainingTotal)}
            </span>
          </div>
        </div>
      </section>

      {/* Box 2: Free Ride Zone & ERG Control OR Scrollable Workout Steps */}
      {isFreeRide ? (
        <section
          className="neon-frame-magenta rounded-lg p-2 flex-1 min-h-0 flex flex-col gap-2"
          aria-label="Free Ride Zone and ERG Target Control"
          data-testid="freeride-panel"
        >
          <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-pink-500/25 shrink-0">
            <span className="text-[11px] font-bold tracking-[0.14em] text-pink-300 uppercase">
              Free Ride Zone
            </span>
            <span className="font-display text-[11px] font-bold text-cyan-200 tabular-nums">
              ERG {freeRideTargetWatts} W
            </span>
          </div>

          {/* Mid-Range ±5 W Adjuster */}
          <div className="rounded-md bg-[#09071c] border border-cyan-500/35 p-2 shrink-0 space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase">
              <span>Mid-Range Center (±{FREE_RIDE_WATT_STEP}W)</span>
              <button
                type="button"
                onClick={resetFreeRideOffset}
                className="text-cyan-300 hover:text-white flex items-center gap-1"
                aria-label="Reset mid-range wattage offset"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>

            <div className="flex items-center justify-between gap-1.5">
              <button
                type="button"
                onClick={() => adjustFreeRideWatts(-FREE_RIDE_WATT_STEP)}
                className="min-h-[48px] min-w-[58px] px-2 rounded-md bg-pink-500/15 border border-pink-400/60 text-pink-200 hover:bg-pink-500/30 font-display text-xs font-bold flex items-center justify-center gap-0.5 transition-colors"
                aria-label="Decrease Free Ride center by 5 watts"
                data-testid="panel-freeride-down"
              >
                <Minus className="w-3.5 h-3.5" />
                5W
              </button>

              <div className="flex flex-col items-center leading-tight min-w-0">
                <span
                  className="font-display text-base font-extrabold tabular-nums text-white"
                  data-testid="panel-freeride-center"
                >
                  {freeRideRange.centerWatts} W
                </span>
                <span className="text-[11px] font-semibold tabular-nums text-cyan-300">
                  {freeRideRange.clampedOffsetWatts >= 0 ? '+' : ''}
                  {freeRideRange.clampedOffsetWatts} W
                </span>
              </div>

              <button
                type="button"
                onClick={() => adjustFreeRideWatts(FREE_RIDE_WATT_STEP)}
                className="min-h-[48px] min-w-[58px] px-2 rounded-md bg-cyan-500/15 border border-cyan-400/60 text-cyan-200 hover:bg-cyan-500/30 font-display text-xs font-bold flex items-center justify-center gap-0.5 transition-colors"
                aria-label="Increase Free Ride center by 5 watts"
                data-testid="panel-freeride-up"
              >
                <Plus className="w-3.5 h-3.5" />
                5W
              </button>
            </div>

            <div className="text-[11px] text-center text-slate-400 tabular-nums">
              Range: <strong className="text-slate-200">{freeRideRange.minWatts}–{freeRideRange.maxWatts} W</strong> (max 15% grade)
            </div>
          </div>

          {/* 7 Touch-Friendly Zone Selector Buttons */}
          <div className="synth-scroll flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1">
            {ALL_ZONES.map((z) => {
              const info = COGGAN_ZONES[z];
              const range = getZoneWattRange(z, ftp);
              const isSelected = freeRideZone === z;
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => {
                    setFreeRideZone(z);
                    onStepClick?.();
                  }}
                  className={`w-full min-h-[48px] px-2.5 py-2 rounded-md border text-left transition-colors flex items-center justify-between gap-2 ${
                    isSelected
                      ? 'bg-[#1a123d] border-2 text-white'
                      : 'bg-[#0b0920]/80 border-slate-700/65 text-slate-200 hover:border-cyan-400/55'
                  }`}
                  style={
                    isSelected
                      ? { borderColor: info.hex, boxShadow: `0 0 12px ${info.hex}44` }
                      : undefined
                  }
                  aria-pressed={isSelected}
                  data-testid={`freeride-zone-${z}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-6 rounded-xs shrink-0"
                      style={{ backgroundColor: info.hex }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="font-display text-xs font-bold leading-tight truncate">
                        {info.code} · {info.shortName}
                      </div>
                      <div className="text-[11px] text-slate-400 leading-tight truncate">
                        {info.name}
                      </div>
                    </div>
                  </div>

                  <span className="font-display text-xs font-bold tabular-nums text-cyan-200 shrink-0">
                    {range.minWatts}–{range.maxWatts}W
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : (
        <section
          className="neon-frame-magenta rounded-lg p-2 flex-1 min-h-0 flex flex-col"
          aria-label="Workout Steps"
        >
          <div className="flex items-center justify-between gap-2 pb-1.5 mb-1 border-b border-pink-500/25 shrink-0">
            <span className="text-[11px] font-bold tracking-[0.14em] text-pink-300 uppercase">
              Workout Steps
            </span>
            <span className="text-[11px] font-semibold text-slate-400 tabular-nums">
              {currentStepIndex + 1} / {activeWorkout.timeline.length}
            </span>
          </div>

          <div
            className="synth-scroll flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1"
            data-testid="workout-steps-list"
          >
            {activeWorkout.tree.map((node: WorkoutTreeNode) =>
              node.type === 'step' ? renderSingleStep(node) : renderRepeatGroup(node)
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export function LeftPanel() {
  const leftDrawerOpen = useAppStore((s) => s.leftDrawerOpen);
  const setLeftDrawerOpen = useAppStore((s) => s.setLeftDrawerOpen);
  const liveTss = useAppStore((s) => s.liveTss);
  const calories = useAppStore((s) => s.calories);
  const elapsedSec = useAppStore((s) => s.elapsedSec);

  return (
    <>
      {/* Desktop & 1146px Portrait Full Left Column (260-272px wide) */}
      <aside className="hidden md:flex flex-col w-[264px] lg:w-[276px] h-full min-h-0 shrink-0">
        <LeftPanelContent />
      </aside>

      {/* Narrow Screen 56px Collapsible Icon Rail */}
      <aside className="flex md:hidden flex-col items-center justify-between w-[56px] h-full shrink-0 neon-frame-cyan rounded-lg py-2 px-1">
        <button
          type="button"
          onClick={() => setLeftDrawerOpen(true)}
          className="w-11 h-11 rounded-md bg-cyan-500/15 border border-cyan-400/50 flex items-center justify-center text-cyan-300 hover:bg-cyan-500/25"
          aria-label="Open workout steps and stats drawer"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>

        <div className="flex flex-col items-center gap-3 text-center">
          <div>
            <Clock className="w-4 h-4 mx-auto text-cyan-300" aria-hidden="true" />
            <div className="font-display text-[10px] tabular-nums text-slate-100 mt-0.5">
              {formatClock(elapsedSec)}
            </div>
          </div>
          <div>
            <Zap className="w-4 h-4 mx-auto text-amber-300" aria-hidden="true" />
            <div className="font-display text-[10px] tabular-nums text-amber-200 mt-0.5">
              {Math.round(liveTss)}
            </div>
          </div>
          <div>
            <Flame className="w-4 h-4 mx-auto text-pink-400" aria-hidden="true" />
            <div className="font-display text-[10px] tabular-nums text-pink-200 mt-0.5">
              {calories}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setLeftDrawerOpen(true)}
          className="w-11 h-11 rounded-md bg-pink-500/15 border border-pink-400/50 flex items-center justify-center text-pink-300 hover:bg-pink-500/25"
          aria-label="View workout steps"
        >
          <ListChecks className="w-5 h-5" />
        </button>
      </aside>

      {/* Narrow Screen Overlay Drawer */}
      {leftDrawerOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden flex bg-black/65"
          role="dialog"
          aria-modal="true"
          aria-label="Workout stats and steps"
        >
          <div className="w-[300px] max-w-[85vw] h-full bg-[#070516] p-3 flex flex-col gap-2 border-r border-cyan-400/60">
            <div className="flex items-center justify-between">
              <span className="font-display text-xs font-bold tracking-widest text-cyan-300 uppercase">
                Ride Panel
              </span>
              <button
                type="button"
                onClick={() => setLeftDrawerOpen(false)}
                className="w-12 h-12 rounded-md border border-cyan-400/40 flex items-center justify-center text-cyan-200"
                aria-label="Close ride panel"
              >
                <PanelLeftClose className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <LeftPanelContent onStepClick={() => setLeftDrawerOpen(false)} />
            </div>
          </div>
          <button
            type="button"
            className="flex-1 cursor-default"
            aria-label="Dismiss drawer"
            onClick={() => setLeftDrawerOpen(false)}
          />
        </div>
      )}
    </>
  );
}
