// Preserve the M3 terminal event contract; M6 owns the shared deterministic rules.
import { matchingSafetyRules } from './safety/engine.js';

export const emergencyMessage = "This information may require urgent attention. I'm stopping the standard intake. Emergency escalation is pending. No dispatcher or emergency service has been contacted.";

export function emergencyFacilityMessage(option) {
  if (!option) return 'Current demo hospital information is unavailable.';
  const distance = Number.isFinite(option.distanceMeters) ? `, about ${(option.distanceMeters / 1000).toFixed(1)} kilometers away` : '';
  const available = option.departmentCapacity?.emergencyAvailable ?? option.capacity?.emergencyBedsAvailable;
  const capacity = Number.isInteger(available) ? ` Its simulated emergency department shows ${available} available ${available === 1 ? 'bed' : 'beds'}.` : '';
  return `Based on the hospital information available in this demo, the nearest emergency-capable option is ${option.hospitalName}${distance}.${capacity} This information is simulated, not live or hospital-verified, and is not a confirmed referral.`;
}

export function emergencyMessageWithFacility(option) {
  return `${emergencyMessage} ${emergencyFacilityMessage(option)}`;
}

export function emergencyEscalation(intake) {
  const rules = matchingSafetyRules(intake);
  const redFlags = (intake?.redFlags || []).filter(flag => flag.status === 'confirmed' && rules.some(rule => rule.flag === flag.type));
  if (!redFlags.length) return null;
  return structuredClone({ type: 'emergency-escalation', caseStatus: 'pending_dispatcher', source: 'intake', redFlags, snapshot: intake });
}
