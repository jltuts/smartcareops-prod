import { createHash } from 'node:crypto';
import { Specialty, RoutingStatus, specialtyLabels } from '../../../shared/routing.js';

// Ordered demo symptom domains, not clinical triage or an urgency ranking.
const rules = Object.freeze([
  { specialty: Specialty.CARDIOLOGY, reasonCode: 'cardiovascular_complaint', reasonSummary: 'Patient reported a chest or cardiovascular complaint.', pattern: /\b(chest pain|chest discomfort|palpitations|heart racing|racing heart|cardiovascular complaint)\b/i },
  { specialty: Specialty.PULMONOLOGY, reasonCode: 'respiratory_complaint', reasonSummary: 'Patient reported a breathing or respiratory complaint.', pattern: /\b(difficulty breathing|breathing difficulty|shortness of breath|short of breath|breathlessness|wheezing|cough|respiratory complaint)\b/i },
  { specialty: Specialty.ENDOCRINOLOGY, reasonCode: 'glucose_complaint', reasonSummary: 'Patient reported a blood glucose or diabetes-related complaint.', pattern: /\b(blood sugar|blood glucose|high glucose|low glucose|diabetes|diabetic)\b/i },
  { specialty: Specialty.NEUROLOGY, reasonCode: 'neurological_complaint', reasonSummary: 'Patient reported dizziness or another neurological complaint.', pattern: /\b(dizziness|dizzy|vertigo|headache|numbness|tingling|neurological complaint)\b/i },
  { specialty: Specialty.ORTHOPEDICS, reasonCode: 'musculoskeletal_complaint', reasonSummary: 'Patient reported a supported musculoskeletal pain or injury complaint.', pattern: /\b(shoulders? pain|pain (?:in|on|over) (?:my |the )?(?:left |right )?shoulders?|shoulder injury|knee pain|pain (?:in|on|over) (?:my |the )?(?:left |right )?knee|knee injury|joint pain|muscle pain|muscle soreness|musculoskeletal complaint)\b/i },
]);
const fallback = Object.freeze({ specialty: Specialty.GENERAL, reasonCode: 'general_complaint', reasonSummary: 'No supported specialty signal matched; Family Medicine selected for review.' });
const evidenceMatches = (evidence, quote) => Number.isInteger(evidence?.utteranceId) && evidence.utteranceId > 0 && typeof quote === 'string' && quote.length > 0 && evidence.patientReportedText === quote;
export const supportedSymptoms = facts => (facts.symptoms || []).filter(item => item.status === 'confirmed' && evidenceMatches(facts.evidence?.[`symptoms.${item.name}`], item.patientReportedText));
export function evaluateRouting(facts) {
  const symptoms = supportedSymptoms(facts);
  const glucose = facts.vitals?.bloodGlucose;
  const qualitativeGlucose = glucose?.source === 'patient_reported' && ['patient reports high', 'patient reports low'].includes(glucose.qualitative) &&
    evidenceMatches(facts.evidence?.['vitals.bloodGlucose'], facts.evidence?.['vitals.bloodGlucose']?.patientReportedText);
  const selected = rules.find(rule => symptoms.some(item => rule.pattern.test(item.patientReportedText)) || rule.specialty === Specialty.ENDOCRINOLOGY && qualitativeGlucose) || fallback;
  return { specialty: selected.specialty, reasonCode: selected.reasonCode, reasonSummary: selected.reasonSummary };
}
export function resolveRouting(facts, availableSpecialties) {
  const selected = evaluateRouting(facts);
  const verifiedSpecialties = availableSpecialties instanceof Set ? availableSpecialties : new Set();
  if (verifiedSpecialties.has(selected.specialty)) return { status: RoutingStatus.ROUTED, ...selected };
  if (selected.specialty !== Specialty.GENERAL && verifiedSpecialties.has(Specialty.GENERAL)) {
    return { status: RoutingStatus.ROUTED, specialty: Specialty.GENERAL, reasonCode: 'general_medicine_fallback',
      reasonSummary: `No verified ${specialtyLabels[selected.specialty]} Doctor is available; routed to the verified Family Medicine queue.` };
  }
  return { status: RoutingStatus.UNASSIGNED, specialty: selected.specialty, reasonCode: 'specialty_unavailable',
    reasonSummary: `No verified ${specialtyLabels[selected.specialty]} Doctor is available; this case remains unassigned.` };
}
// Firestore may return map fields in a different order. Array order remains
// meaningful; object-key order must not trigger an accidental reroute conflict.
export const factsFingerprint = facts => createHash('sha256').update(JSON.stringify(facts, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
export function validRouting(routing) {
  const rule = [...rules, fallback].find(item => item.specialty === routing?.specialty);
  const validTime = typeof routing?.routedAt === 'string' && Number.isFinite(Date.parse(routing.routedAt));
  if (!rule || !validTime) return false;
  if (routing.status === RoutingStatus.ROUTED && routing.reasonCode === rule.reasonCode && routing.reasonSummary === rule.reasonSummary) return true;
  if (routing.status === RoutingStatus.UNASSIGNED) return routing.reasonCode === 'specialty_unavailable' &&
    routing.reasonSummary === `No verified ${specialtyLabels[routing.specialty]} Doctor is available; this case remains unassigned.`;
  return routing.status === RoutingStatus.ROUTED && routing.specialty === Specialty.GENERAL && routing.reasonCode === 'general_medicine_fallback' &&
    rules.some(item => item.specialty !== Specialty.GENERAL && routing.reasonSummary === `No verified ${specialtyLabels[item.specialty]} Doctor is available; routed to the verified Family Medicine queue.`);
}
export const publicRouting = routing => validRouting(routing) ? Object.fromEntries(['status', 'specialty', 'reasonCode', 'reasonSummary', 'routedAt'].map(key => [key, routing[key]])) : null;
