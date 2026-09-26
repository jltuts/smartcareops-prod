import { safetyRules } from './rules.js';

// Input is the validated M2 snapshot, never a model workflow command or raw text.
export function matchingSafetyRules(intake) {
  return safetyRules.filter(rule => (intake?.redFlags || []).some(flag => {
    const evidence = intake.evidence?.[`redFlags.${rule.flag}`];
    return flag.type === rule.flag && flag.status === 'confirmed' && Number.isInteger(evidence?.utteranceId) && evidence.utteranceId > 0 &&
      typeof flag.patientReportedText === 'string' && flag.patientReportedText.trim().length > 0 && evidence.patientReportedText === flag.patientReportedText;
  }));
}
export function evaluateSafety(intake) {
  const matched = matchingSafetyRules(intake);
  if (!matched.length) return { emergency: false, matchedRule: null };
  return { emergency: true, matchedRule: matched[0].reasonCode, reasonCode: matched[0].reasonCode, reasonSummary: matched[0].reasonSummary, triggeredBy: matched.map(rule => rule.trigger) };
}
