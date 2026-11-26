export type ZoneNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PowerZoneInfo {
  zone: ZoneNumber;
  code: string;
  name: string;
  shortName: string;
  minPct: number;
  maxPct: number | null;
  hex: string;
  glowHex: string;
  bgTint: string;
  borderHex: string;
}

export const COGGAN_ZONES: Record<ZoneNumber, PowerZoneInfo> = {
  1: {
    zone: 1,
    code: 'Z1',
    name: 'Active Recovery',
    shortName: 'RECOVERY',
    minPct: 0,
    maxPct: 55,
    hex: '#6495ed',
    glowHex: '#8ab4ff',
    bgTint: 'rgba(100, 149, 237, 0.2)',
    borderHex: '#7da7f5',
  },
  2: {
    zone: 2,
    code: 'Z2',
    name: 'Endurance',
    shortName: 'ENDURANCE',
    minPct: 56,
    maxPct: 75,
    hex: '#00e5ff',
    glowHex: '#5cf4ff',
    bgTint: 'rgba(0, 229, 255, 0.18)',
    borderHex: '#00e5ff',
  },
  3: {
    zone: 3,
    code: 'Z3',
    name: 'Tempo',
    shortName: 'TEMPO',
    minPct: 76,
    maxPct: 90,
    hex: '#22ff88',
    glowHex: '#6effb0',
    bgTint: 'rgba(34, 255, 136, 0.18)',
    borderHex: '#22ff88',
  },
  4: {
    zone: 4,
    code: 'Z4',
    name: 'Threshold',
    shortName: 'THRESHOLD',
    minPct: 91,
    maxPct: 105,
    hex: '#ffe01b',
    glowHex: '#ffed6e',
    bgTint: 'rgba(255, 224, 27, 0.18)',
    borderHex: '#ffe01b',
  },
  5: {
    zone: 5,
    code: 'Z5',
    name: 'VO2max',
    shortName: 'VO2MAX',
    minPct: 106,
    maxPct: 120,
    hex: '#ff7a18',
    glowHex: '#ffa152',
    bgTint: 'rgba(255, 122, 24, 0.2)',
    borderHex: '#ff7a18',
  },
  6: {
    zone: 6,
    code: 'Z6',
    name: 'Anaerobic',
    shortName: 'ANAEROBIC',
    minPct: 121,
    maxPct: 150,
    hex: '#ff1e6b',
    glowHex: '#ff5c96',
    bgTint: 'rgba(255, 30, 107, 0.22)',
    borderHex: '#ff1e6b',
  },
  7: {
    zone: 7,
    code: 'Z7',
    name: 'Neuromuscular',
    shortName: 'NEUROMUSCULAR',
    minPct: 151,
    maxPct: null,
    hex: '#c026d3',
    glowHex: '#e879f9',
    bgTint: 'rgba(192, 38, 211, 0.24)',
    borderHex: '#d946ef',
  },
};

/**
 * Determine Coggan Power Zone from power fraction of FTP (before intensity offset).
 * Z1 < 55%, Z2 56-75%, Z3 76-90%, Z4 91-105%, Z5 106-120%, Z6 121-150%, Z7 > 150%.
 */
export function getPowerZone(powerFraction: number): PowerZoneInfo {
  const pct = powerFraction * 100;
  if (pct < 55.5) return COGGAN_ZONES[1];
  if (pct <= 75.5) return COGGAN_ZONES[2];
  if (pct <= 90.5) return COGGAN_ZONES[3];
  if (pct <= 105.5) return COGGAN_ZONES[4];
  if (pct <= 120.5) return COGGAN_ZONES[5];
  if (pct <= 150.5) return COGGAN_ZONES[6];
  return COGGAN_ZONES[7];
}

/**
 * Compute target ERG watts: step power fraction * FTP * (1 + intensityOffsetPct / 100).
 */
export function getTargetWatts(
  powerFraction: number,
  ftp: number,
  intensityOffsetPct: number
): number {
  const effectiveFtp = getEffectiveFtp(ftp, intensityOffsetPct);
  return Math.max(0, Math.round(powerFraction * effectiveFtp));
}

export function getEffectiveFtp(ftp: number, intensityOffsetPct: number): number {
  return Math.max(50, Math.round(ftp * (1 + intensityOffsetPct / 100)));
}

/**
 * Estimate virtual road speed (km/h) from cycling power on flat road using
 * aerodynamic drag + rolling resistance cubic equilibrium:
 * P = (0.5 * rho * CdA * v^3 + Crr * m * g * v) / drivetrainEff
 */
export function powerToSpeedKmh(watts: number): number {
  if (watts <= 1) return 0;
  const rho = 1.225;
  const cda = 0.32;
  const crr = 0.004;
  const massKg = 78;
  const g = 9.81;
  const eff = 0.97;
  const target = watts * eff;

  // Newton-Raphson for speed v (m/s)
  let v = 8;
  for (let i = 0; i < 8; i++) {
    const f = 0.5 * rho * cda * v * v * v + crr * massKg * g * v - target;
    const df = 1.5 * rho * cda * v * v + crr * massKg * g;
    v = Math.max(0, v - f / df);
  }
  return Math.round(v * 3.6 * 10) / 10;
}

export function formatClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatShortDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  if (clamped < 60) {
    return `${clamped} s`;
  }
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  if (secs === 0) {
    return `${mins} min`;
  }
  return `${mins}m ${secs}s`;
}
