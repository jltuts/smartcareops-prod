import { emptyIntake } from '../src/intake/schema.js';
import { mergeIntake } from '../src/intake/validate.js';

export function emergencyIntake(type = 'current chest pain', status = 'confirmed') {
  const quote = status === 'denied' ? `I do not have ${type}.` : status === 'unclear' ? `Maybe I have ${type}.` : `I have ${type} now.`;
  const utterance = { id: 1, role: 'Patient', text: quote, question: `Do you have ${type}?` };
  return mergeIntake(emptyIntake(), { updates: [{ kind: 'redFlag', label: type, value: null, secondaryValue: null, unit: null, qualitative: null, status, evidenceId: 1, quote }] }, [utterance]);
}
