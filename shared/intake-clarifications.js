// Derive required repairs from current evidence; historical request errors are not facts.
export function pendingClarifications(intake) {
  const result = (intake?.validationClarifications || []).filter((item, index, all) => all.findIndex(other => other.key === item.key) === index);
  for (const [collection, labelKey] of [['symptoms', 'name'], ['redFlags', 'type']]) {
    for (const item of intake?.[collection] || []) {
      const key = `${collection}.${item[labelKey]}`;
      const evidence = intake.evidence?.[key];
      const garbled = (/chest pain/i.test(item[labelKey]) && /chess (?:piece|playing)/i.test(item.patientReportedText)) ||
        (/breath/i.test(item[labelKey]) && /reading difficulty/i.test(item.patientReportedText)) || /^아\s*,?\s*no[.!\s]*$/u.test(item.patientReportedText);
      if (item.status === 'unclear' && (evidence?.clarificationRequested || garbled)) {
        // A guard-created mirror is the same repair, not another patient answer.
        const repairKey = evidence?.derivedFrom || key;
        if (!result.some(repair => repair.key === repairKey)) result.push({ key: repairKey, utteranceId: evidence?.utteranceId });
      }
    }
  }
  const glucose = intake?.vitals?.bloodGlucose;
  const evidence = intake?.evidence?.['vitals.bloodGlucose'];
  if (glucose?.unit === null && /\bmmol\b/i.test(evidence?.patientReportedText || '') && !/\bmmol\s*\/\s*l\b/i.test(evidence?.patientReportedText || '')) {
    if (!result.some(item => item.key === 'vitals.bloodGlucose')) result.push({ key: 'vitals.bloodGlucose', utteranceId: evidence?.utteranceId });
  }
  return result;
}
