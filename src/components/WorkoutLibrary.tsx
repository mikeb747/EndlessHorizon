import { useMemo, useState } from 'react';
import { ArrowLeft, FolderOpen, Mountain, Play, Search } from 'lucide-react';
import { formatClock, formatShortDuration, getTargetWatts } from '../core/zones';
import { WorkoutTreeNode } from '../core/zwoParser';
import { useAppStore } from '../store/useAppStore';
import { MiniProfileChart } from './MiniProfileChart';

export function WorkoutLibrary() {
  const workouts = useAppStore((s) => s.workouts);
  const activeWorkout = useAppStore((s) => s.activeWorkout);
  const ftp = useAppStore((s) => s.ftp);
  const selectWorkout = useAppStore((s) => s.selectWorkout);
  const startFreeRide = useAppStore((s) => s.startFreeRide);
  const setScreen = useAppStore((s) => s.setScreen);

  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>('All');
  const [previewId, setPreviewId] = useState<string>(activeWorkout.id);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    workouts.forEach((w) => w.tags.forEach((t) => tagSet.add(t)));
    return ['All', ...Array.from(tagSet)];
  }, [workouts]);

  const filteredWorkouts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workouts.filter((w) => {
      const matchesTag = selectedTag === 'All' || w.tags.includes(selectedTag);
      const matchesQuery =
        q === '' ||
        w.name.toLowerCase().includes(q) ||
        w.author.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.tags.some((t) => t.toLowerCase().includes(q));
      return matchesTag && matchesQuery;
    });
  }, [workouts, query, selectedTag]);

  const previewWorkout =
    filteredWorkouts.find((w) => w.id === previewId) ?? filteredWorkouts[0] ?? activeWorkout;

  const formatNodeSummary = (node: WorkoutTreeNode) => {
    if (node.type === 'step') {
      const lowW = getTargetWatts(node.powerLow, ftp, 0);
      const highW = getTargetWatts(node.powerHigh, ftp, 0);
      const wattsLabel = Math.abs(lowW - highW) <= 1 ? `${lowW} W` : `${lowW}–${highW} W`;
      return `${formatShortDuration(node.duration)} ${node.label} @ ${wattsLabel}`;
    }
    const parts = node.childrenTemplate.map(
      (c) => `${formatShortDuration(c.duration)} @ ${getTargetWatts(c.powerLow, ftp, 0)} W`
    );
    return `${node.repeat}× { ${parts.join(', ')} }`;
  };

  return (
    <div
      className="h-screen w-screen overflow-hidden bg-[#060412] flex flex-col"
      data-testid="workout-library"
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-4 px-5 sm:px-8 py-4 border-b border-cyan-500/30 bg-[#08061a] shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setScreen('menu')}
            className="min-h-[48px] min-w-[48px] rounded-md bg-[#110e2d] border border-cyan-500/45 text-cyan-200 hover:bg-cyan-500/20 flex items-center justify-center shrink-0"
            aria-label="Back to main menu"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-lg sm:text-xl font-extrabold tracking-wider text-white uppercase truncate">
              Workout Library
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Built-in structured workouts · Stage 4 adds local .zwo folder sync &amp; file import
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled
            className="hidden sm:flex min-h-[48px] px-4 rounded-md bg-[#0f0c24] border border-slate-700 text-slate-500 text-xs font-bold uppercase tracking-wider items-center gap-2 cursor-not-allowed whitespace-nowrap"
            title="Workout folder access unlocks in Stage 4"
          >
            <FolderOpen className="w-4 h-4" />
            Open Folder (Stage 4)
          </button>
          <button
            type="button"
            onClick={() => startFreeRide(2, false)}
            className="min-h-[48px] px-4 rounded-md bg-pink-500/20 border border-pink-400 text-pink-100 font-display text-xs font-bold uppercase tracking-wider hover:bg-pink-500/35 flex items-center gap-2 whitespace-nowrap"
            data-testid="library-start-freeride"
          >
            <Mountain className="w-4 h-4" />
            Free Ride
          </button>
          <button
            type="button"
            onClick={() => setScreen('ride')}
            className="min-h-[48px] px-4 rounded-md bg-cyan-500/20 border border-cyan-400 text-cyan-100 font-display text-xs font-bold uppercase tracking-wider hover:bg-cyan-500/35 whitespace-nowrap"
          >
            Return to Ride
          </button>
        </div>
      </header>

      {/* Main Split Content */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 sm:p-6 overflow-hidden">
        {/* Left List + Search & Tag Filter */}
        <section className="lg:col-span-5 flex flex-col gap-3 min-h-0">
          <div className="relative shrink-0">
            <Search
              className="w-4 h-4 text-cyan-300 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workouts, author, or tags..."
              aria-label="Search workouts"
              className="w-full min-h-[48px] pl-10 pr-4 rounded-lg bg-[#0b0920] border border-cyan-500/45 text-sm text-white placeholder:text-slate-400 focus:outline-none focus:border-cyan-300"
            />
          </div>

          {/* Interactive Tag Filter Controls */}
          <div className="flex flex-wrap gap-1.5 shrink-0" role="group" aria-label="Filter by tag">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setSelectedTag(tag)}
                className={`min-h-[40px] px-3.5 rounded-md text-xs font-bold tracking-wide transition-colors border whitespace-nowrap ${
                  selectedTag === tag
                    ? 'bg-pink-500/25 border-pink-400 text-white'
                    : 'bg-[#0b0920] border-slate-700/80 text-slate-300 hover:border-cyan-400/50'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>

          {/* Workout Cards List */}
          <div className="synth-scroll flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
            {filteredWorkouts.length === 0 ? (
              <div className="neon-frame-cyan rounded-lg p-6 text-center text-slate-300">
                <p className="font-display text-sm font-bold text-cyan-200">No matching workouts</p>
                <p className="text-xs text-slate-400 mt-1">
                  Try clearing the search query or selecting All tags.
                </p>
              </div>
            ) : (
              filteredWorkouts.map((w) => {
                const isSelected = w.id === previewWorkout.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setPreviewId(w.id)}
                    className={`w-full text-left rounded-xl p-4 transition-colors border-2 ${
                      isSelected
                        ? 'neon-frame-hud'
                        : 'bg-[#0b0920] border-slate-700/70 hover:border-cyan-500/55'
                    }`}
                    data-testid={`workout-card-${w.id}`}
                  >
                    <h2 className="font-display text-base font-bold text-white leading-snug">
                      {w.name}
                    </h2>
                    <div className="text-xs text-slate-400 mt-1">
                      <span>by {w.author}</span>
                      <span className="mx-1.5">·</span>
                      <span className="tabular-nums text-cyan-200 font-semibold">
                        {formatClock(w.totalDuration)}
                      </span>
                      <span className="mx-1.5">·</span>
                      <span className="tabular-nums text-pink-300 font-semibold">
                        {w.estimatedTss} TSS
                      </span>
                      <span className="mx-1.5">·</span>
                      <span>IF {w.intensityFactor.toFixed(2)}</span>
                    </div>
                    <div className="mt-3">
                      <MiniProfileChart workout={w} ftp={ftp} height={64} />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Right Detailed Workout Preview Pane */}
        <section className="lg:col-span-7 neon-frame-cyan rounded-xl p-5 flex flex-col gap-4 min-h-0 overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <div className="text-xs text-cyan-300 font-semibold tracking-wider uppercase">
                Workout Preview · FTP {ftp} W
              </div>
              <h2 className="font-display text-xl sm:text-2xl font-extrabold text-white mt-1">
                {previewWorkout.name}
              </h2>
              <p className="text-sm text-slate-400 mt-0.5">
                {previewWorkout.author} · {formatClock(previewWorkout.totalDuration)} ·{' '}
                {previewWorkout.estimatedTss} TSS
                {previewWorkout.tags.length > 0 ? ` · ${previewWorkout.tags.join(' / ')}` : ''}
              </p>
            </div>

            <button
              type="button"
              onClick={() => selectWorkout(previewWorkout.id, true)}
              className="min-h-[52px] px-6 rounded-lg bg-gradient-to-r from-cyan-500 to-pink-500 text-slate-950 font-display text-sm font-extrabold uppercase tracking-wider flex items-center gap-2 hover:brightness-110 transition-all whitespace-nowrap shrink-0"
              data-testid="btn-load-and-ride"
            >
              <Play className="w-5 h-5 fill-current" />
              Load &amp; Start Ride
            </button>
          </div>

          <p className="text-sm text-slate-300 leading-relaxed shrink-0 whitespace-pre-line max-h-28 overflow-y-auto synth-scroll pr-1">
            {previewWorkout.description}
          </p>

          <div className="shrink-0">
            <MiniProfileChart workout={previewWorkout} ftp={ftp} height={110} />
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <h3 className="font-display text-xs font-bold tracking-[0.16em] text-pink-300 uppercase mb-2 shrink-0">
              Structured Intervals ({previewWorkout.timeline.length} flattened steps)
            </h3>
            <ul className="synth-scroll flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1">
              {previewWorkout.tree.map((node) => (
                <li
                  key={node.id}
                  className="px-3 py-2 rounded-md bg-[#09071c] border border-cyan-500/25 text-sm text-slate-200 font-medium"
                >
                  {formatNodeSummary(node)}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
