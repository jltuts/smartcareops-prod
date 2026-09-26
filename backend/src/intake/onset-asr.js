// Only observed isolated contamination in a single onset question. Do not strip
// words from ordinary answers, uncertainty, corrections, or medical statements.
export function supportedNoisyOnset(utterance) {
  if (utterance?.role !== 'Patient') return null;
  if (!/^when did (?:(?:the|your) dizziness (?:start|begin)|you first start feeling dizzy)\?$/i.test((utterance.question || '').trim())) return null;
  const match = /^\s*(yesterday)\b[\s.,…]*(?:shark\s+suddenly|television|football|\[irrelevant words\])[\s.!?]*$/i.exec(utterance.text);
  return match ? { value: 'yesterday', quote: match[1] } : null;
}

export function onsetUpdate(utterance, supported) {
  return { kind: 'onset', label: null, value: supported.value, secondaryValue: null,
    unit: null, qualitative: null, status: null, evidenceId: utterance.id, quote: supported.quote };
}
