import { safetyRules } from './rules.js';
import { EmergencyStatus } from '../../../shared/emergency.js';

const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
export function publicEmergency(value) {
  const rule = safetyRules.find(rule => rule.reasonCode === value?.reasonCode);
  if (!rule || rule.reasonSummary !== value.reasonSummary || !Object.values(EmergencyStatus).includes(value.status) || !iso(value.triggeredAt) ||
      !Array.isArray(value.triggeredBy) || !value.triggeredBy.length || value.triggeredBy.length > safetyRules.length ||
      new Set(value.triggeredBy).size !== value.triggeredBy.length || !value.triggeredBy.includes(rule.trigger) ||
      value.triggeredBy.some(trigger => !safetyRules.some(rule => rule.trigger === trigger))) return null;
  if (value.status === EmergencyStatus.PENDING ? value.acknowledgedAt !== null || value.acknowledgedBy !== null : !iso(value.acknowledgedAt) || value.acknowledgedBy !== 'demo_dispatcher' || value.acknowledgedAt < value.triggeredAt) return null;
  return Object.fromEntries(['status', 'reasonCode', 'reasonSummary', 'triggeredBy', 'triggeredAt', 'acknowledgedAt', 'acknowledgedBy'].map(key => [key, value[key]]));
}
export function emergencyMetadata(decision, now) {
  return { status: EmergencyStatus.PENDING, reasonCode: decision.reasonCode, reasonSummary: decision.reasonSummary, triggeredBy: decision.triggeredBy, triggeredAt: now, acknowledgedAt: null, acknowledgedBy: null };
}
