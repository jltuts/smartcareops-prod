export function validAssessment(evidenceRefs) {
  const primary = evidenceRefs[0];
  return {
    caseSummary: 'Fictional case remains under human review.',
    importantFindings: [{ summary: 'A fictional symptom was reported.', evidenceRefs: [primary] }],
    observations: [{ summary: 'Only the supplied fictional evidence was reviewed.', evidenceRefs: [primary] }],
    hypotheses: [{ summary: 'Possible explanations remain uncertain.', evidenceRefs: [primary] }],
    risks: [],
    differentialConsiderations: [{ summary: 'Human clinical review remains necessary.', evidenceRefs: [primary] }],
    uncertainty: ['No diagnosis is established.'],
    recommendedNextStep: 'Retain a read-only review.',
    whyRecommended: [{ summary: 'The available evidence is limited.', evidenceRefs: [primary] }],
    alternatives: [],
    whatWouldChangeRecommendation: ['New verified evidence.'],
    uncertainties: ['The cause is uncertain.'],
    conflictingEvidence: [],
    missingInformation: ['No approved policy source is available.'],
    changeSummary: 'No prior assessment was changed.',
    recommendedActions: [{ toolName: 'read_case', expectedOutcome: 'Review the bound fictional case.', proposedRisk: 'READ_ONLY' }],
    monitoringConditions: ['Review if verified evidence changes.'],
  };
}

export async function boundedAgent({ binding, callTool }) {
  const evidence = await callTool('get_case_evidence', {});
  const refs = [...evidence.evidenceRefs];
  if (binding.labBinding) refs.push((await callTool('get_verified_lab_revision', {})).evidenceRef);
  if (binding.policyVersion) {
    const passages = await callTool('retrieve_approved_policy', { query: 'fictional review policy' });
    refs.push(...passages.map(item => item.evidenceRef));
  }
  const value = validAssessment(refs);
  if (binding.policyVersion && refs.some(ref => ref.startsWith('POLICY-'))) {
    value.whyRecommended = refs.filter(ref => ref.startsWith('POLICY-')).map(ref => ({ summary: 'A fictional policy passage was considered.', evidenceRefs: [ref] }));
  }
  return value;
}
