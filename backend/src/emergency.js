// Preserve the M3 terminal event contract; M6 owns the shared deterministic rules.
import { matchingSafetyRules } from './safety/engine.js';

export const emergencyMessage = "This information may require urgent attention. I'm stopping the standard intake. Emergency escalation is pending. No dispatcher or emergency service has been contacted.";

export function emergencyEscalation(intake) {
  const rules = matchingSafetyRules(intake);
  const redFlags = (intake?.redFlags || []).filter(flag => flag.status === 'confirmed' && rules.some(rule => rule.flag === flag.type));
  if (!redFlags.length) return null;
  return structuredClone({ type: 'emergency-escalation', caseStatus: 'pending_dispatcher', source: 'intake', redFlags, snapshot: intake });
}
