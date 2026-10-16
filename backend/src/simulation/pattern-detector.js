export const RESPIRATORY_WINDOW_MINUTES = 90;
export const RESPIRATORY_BASELINE_COUNT = 2;
export const RESPIRATORY_MINIMUM_COUNT = 5;
export const RESPIRATORY_REGION = 'REGION-DEMO-001';

// Synthetic-only demo stream: one additional presentation appears every three
// M15 ticks (15 simulated minutes). No patient case store or identity is read.
export function createSyntheticRespiratorySignals(simulation) {
  const tick = Number.isSafeInteger(simulation?.tick) && simulation.tick >= 0 ? simulation.tick : 0;
  const observedCount = RESPIRATORY_BASELINE_COUNT + Math.min(12, Math.floor(tick / 3));
  const spacing = Math.floor(RESPIRATORY_WINDOW_MINUTES / observedCount);
  return Array.from({ length: observedCount }, (_, index) => ({
    category: 'respiratory', regionId: RESPIRATORY_REGION, minutesAgo: index * spacing,
  }));
}

export function detectRespiratoryPattern(signals, { baselineCount = RESPIRATORY_BASELINE_COUNT, windowMinutes = RESPIRATORY_WINDOW_MINUTES } = {}) {
  const groups = new Map(); let totalCount = 0;
  for (const signal of signals || []) {
    if (signal?.category !== 'respiratory' || typeof signal.regionId !== 'string' ||
        !Number.isFinite(signal.minutesAgo) || signal.minutesAgo < 0 || signal.minutesAgo >= windowMinutes) continue;
    totalCount++; groups.set(signal.regionId, (groups.get(signal.regionId) || 0) + 1);
  }
  const candidates = [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [regionId, observedCount] = candidates[0] || [null, 0];
  const concentrated = observedCount >= RESPIRATORY_MINIMUM_COUNT && observedCount / Math.max(totalCount, 1) >= 0.75;
  const detected = observedCount >= RESPIRATORY_MINIMUM_COUNT && observedCount >= baselineCount * 2.5 && concentrated;
  const severity = observedCount >= 12 ? 'critical' : observedCount >= 8 ? 'warning' : 'watch';
  return {
    detected, type: 'respiratory', regionId, windowMinutes, observedCount, baselineCount,
    trend: observedCount > baselineCount ? 'rising' : 'stable', severity: detected ? severity : 'watch',
    projectedEdDemandIncreasePercent: Math.min(80, observedCount * 4),
    concentrationCount: observedCount,
  };
}
