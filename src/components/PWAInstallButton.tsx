import { useState } from 'react';
import { Download, Smartphone, WifiOff } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export function PWAInstallButton({ compact = false }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={
          compact
            ? 'inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/60 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-1.5 text-xs font-display font-bold tracking-wider uppercase text-cyan-200 transition cursor-pointer'
            : 'w-full flex items-center justify-center gap-2 rounded-lg border border-cyan-400/70 bg-cyan-500/20 hover:bg-cyan-500/30 px-4 py-2.5 text-sm font-display font-bold tracking-wider uppercase text-cyan-100 transition cursor-pointer'
        }
        data-testid="pwa-install-btn"
      >
        <Download className="w-4 h-4" />
        Install App (Offline Ready)
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={
            compact
              ? 'inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-[#0d0a24] hover:border-cyan-300 px-3 py-1.5 text-xs font-display font-bold tracking-wider uppercase text-cyan-200 transition cursor-pointer'
              : 'w-full flex items-center justify-center gap-2 rounded-lg border border-cyan-500/50 bg-[#0d0a24] hover:border-cyan-300 px-4 py-2.5 text-sm font-display font-bold tracking-wider uppercase text-cyan-200 transition cursor-pointer'
          }
          data-testid="pwa-ios-install-btn"
        >
          <Smartphone className="w-4 h-4" />
          Install on iPhone / iPad
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-xl border border-cyan-400/50 bg-[#0c0820] p-5 shadow-2xl">
              <h3 className="font-display text-base font-bold tracking-wider text-cyan-200 uppercase">
                Install on iOS Safari
              </h3>
              <p className="mt-2 text-sm text-slate-300 leading-relaxed">
                1. Tap the <strong className="text-white">Share</strong> button in Safari&apos;s toolbar.
                <br />
                2. Scroll down and tap <strong className="text-white">Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-lg border border-cyan-400/60 bg-cyan-500/20 hover:bg-cyan-500/30 py-2 text-xs font-display font-bold uppercase tracking-wider text-cyan-100 transition cursor-pointer"
              >
                Got It
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      className="fixed bottom-3 left-3 z-[65] flex items-center gap-2 rounded-lg border border-amber-400/70 bg-[#1a1006]/95 px-3 py-1.5 text-xs font-display font-semibold tracking-wider text-amber-200 shadow-lg"
      data-testid="offline-indicator"
    >
      <WifiOff className="w-3.5 h-3.5 text-amber-300 shrink-0" />
      <span>OFFLINE MODE · Cached workouts &amp; local FIT recording active</span>
    </div>
  );
}
