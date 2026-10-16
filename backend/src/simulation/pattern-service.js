import { randomUUID } from 'node:crypto';
import { createSyntheticRespiratorySignals, detectRespiratoryPattern } from './pattern-detector.js';
import { createPatternModel, validatePatternInterpretation } from './pattern-model.js';
import { syncPatternNotifications } from './pattern-notifications.js';

export class PatternError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const publicAlert = alert => alert ? {
  alertId: alert.alertId, type: alert.type, severity: alert.severity, generatedAt: alert.generatedAt, updatedAt: alert.updatedAt,
  region: alert.region, observedCount: alert.observedCount, baselineCount: alert.baselineCount,
  windowMinutes: alert.windowMinutes, trend: alert.trend,
  projectedEdDemandIncreasePercent: alert.projectedEdDemandIncreasePercent,
  acknowledged: alert.acknowledged, acknowledgedAt: alert.acknowledgedAt,
  interpretationStatus: alert.interpretationStatus, interpretation: alert.interpretation,
} : null;

export function createPatternService({ simulationStore, store, interpret = createPatternModel(), now = Date.now } = {}) {
  if (!simulationStore || !store) throw new TypeError('PATTERN_STORES_REQUIRED');
  async function view() {
    try { const saved = await store.get(); return { alert: publicAlert(saved?.alert), scan: saved?.scan ?? null }; }
    catch { throw new PatternError('PATTERN_UNAVAILABLE', 503); }
  }
  async function refresh() {
    let pattern;
    try { pattern = detectRespiratoryPattern(createSyntheticRespiratorySignals(await simulationStore.get())); }
    catch { throw new PatternError('SIMULATION_UNAVAILABLE', 503); }
    try {
      const previous = await store.get(), prior = previous?.alert;
      if (!pattern.detected) {
        const timestamp = new Date(now()).toISOString();
        await store.save({ ...previous, alert: null, scan: { type: pattern.type, region: pattern.regionId, observedCount: pattern.observedCount,
          baselineCount: pattern.baselineCount, windowMinutes: pattern.windowMinutes, detected: false, scannedAt: timestamp },
        notifications: syncPatternNotifications(previous, null, timestamp) });
        return { alert: null, scan: { type: pattern.type, region: pattern.regionId, observedCount: pattern.observedCount,
          baselineCount: pattern.baselineCount, windowMinutes: pattern.windowMinutes, detected: false } };
      }
      const samePattern = prior?.type === pattern.type && prior?.region === pattern.regionId;
      const alert = { alertId: samePattern ? prior.alertId : `M18-${randomUUID()}`, type: pattern.type, severity: pattern.severity,
        generatedAt: samePattern ? prior.generatedAt : new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
        region: pattern.regionId, observedCount: pattern.observedCount, baselineCount: pattern.baselineCount,
        windowMinutes: pattern.windowMinutes, trend: pattern.trend,
        projectedEdDemandIncreasePercent: pattern.projectedEdDemandIncreasePercent,
        acknowledged: samePattern ? prior.acknowledged : false,
        acknowledgedBy: samePattern ? prior.acknowledgedBy ?? null : null,
        acknowledgedAt: samePattern ? prior.acknowledgedAt ?? null : null,
        interpretationStatus: samePattern ? prior.interpretationStatus : 'pending',
        interpretation: samePattern ? prior.interpretation ?? null : null };
      await store.save({ ...previous, alert, scan: { type: pattern.type, region: pattern.regionId, observedCount: pattern.observedCount,
        baselineCount: pattern.baselineCount, windowMinutes: pattern.windowMinutes, detected: true, scannedAt: alert.updatedAt },
      notifications: syncPatternNotifications(previous, alert, alert.updatedAt) });
      if (!samePattern || alert.interpretationStatus === 'pending') {
        try {
          const interpretation = validatePatternInterpretation(await interpret({ severity: pattern.severity, trend: pattern.trend }));
          Object.assign(alert, { interpretationStatus: 'succeeded', interpretation });
        } catch { Object.assign(alert, { interpretationStatus: 'unavailable', interpretation: null }); }
        try { const saved = await store.get(); await store.save({ ...saved, alert, scan: { type: pattern.type, region: pattern.regionId, observedCount: pattern.observedCount,
          baselineCount: pattern.baselineCount, windowMinutes: pattern.windowMinutes, detected: true, scannedAt: alert.updatedAt },
        notifications: syncPatternNotifications(saved, alert, alert.updatedAt) }); }
        catch { Object.assign(alert, { interpretationStatus: 'unavailable', interpretation: null }); }
      }
      return { alert: publicAlert(alert), scan: { type: pattern.type, region: pattern.regionId, observedCount: pattern.observedCount,
        baselineCount: pattern.baselineCount, windowMinutes: pattern.windowMinutes, detected: true } };
    } catch (error) {
      if (error instanceof PatternError) throw error;
      throw new PatternError('PATTERN_STORE_UNAVAILABLE', 503);
    }
  }
  async function acknowledge(alertId, uid) {
    if (typeof alertId !== 'string' || !/^M18-[0-9a-f-]{36}$/.test(alertId) || typeof uid !== 'string' || !uid) throw new PatternError('INVALID_ACKNOWLEDGEMENT');
    try {
      const current = await store.get(), alert = current?.alert;
      if (!alert || alert.alertId !== alertId) throw new PatternError('PATTERN_ALERT_STALE', 409);
      if (!alert.acknowledged) {
        const acknowledgedAt = new Date(now()).toISOString();
        const acknowledged = { ...alert, acknowledged: true, acknowledgedBy: uid, acknowledgedAt, updatedAt: acknowledgedAt };
        await store.save({ ...current, alert: acknowledged, notifications: syncPatternNotifications(current, acknowledged, acknowledgedAt) });
      }
      return view();
    } catch (error) {
      if (error instanceof PatternError) throw error;
      throw new PatternError('PATTERN_STORE_UNAVAILABLE', 503);
    }
  }
  return { view, refresh, acknowledge, close: async () => { await store.close?.(); } };
}
