const cleanText = (value, max) => {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean && clean.length <= max && !/[<>\u0000-\u001f\u007f]/.test(clean) ? clean : null;
};

export const medicationCandidateSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['identified', 'unclear'] },
    name: { type: 'string' },
    strength: { type: 'string' },
  },
  required: ['status', 'name', 'strength'],
});

export function validateMedicationCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'name,status,strength' ||
      !['identified', 'unclear'].includes(value.status)) throw new Error('INVALID_MEDICATION_CANDIDATE');
  if (value.status === 'unclear') {
    if (value.name !== '' || value.strength !== '') throw new Error('INVALID_MEDICATION_CANDIDATE');
    return { status: 'unclear', name: '', strength: '' };
  }
  const name = cleanText(value.name, 120), strength = cleanText(value.strength, 80);
  if (!name || !strength) throw new Error('INVALID_MEDICATION_CANDIDATE');
  return { status: 'identified', name, strength };
}

export function validateConfirmedMedication(value) {
  const name = cleanText(value?.name, 120), strength = cleanText(value?.strength, 80), howTaken = cleanText(value?.howTaken, 500);
  if (!name || !strength || !howTaken || value?.confirmed !== true) throw new Error('INVALID_MEDICATION_ENTRY');
  return Object.freeze({ name, strength, howTaken, source: 'packaging_shown', verification: 'patient_reported' });
}

export function validateVoiceMedicationDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'confirmedReading,howTaken,name,strength' ||
      typeof value.confirmedReading !== 'boolean') throw new Error('INVALID_MEDICATION_DRAFT');
  const name = cleanText(value.name, 120), strength = cleanText(value.strength, 80), howTaken = cleanText(value.howTaken, 500);
  if (!name || !strength || !howTaken) throw new Error('INVALID_MEDICATION_DRAFT');
  return Object.freeze({ name, strength, howTaken, confirmedReading: value.confirmedReading });
}

export const publicMedication = value => value ? {
  name: value.name, strength: value.strength, howTaken: value.howTaken,
  source: 'packaging_shown', verification: 'patient_reported', confirmedAt: value.confirmedAt,
} : null;

export function validatePersistedMedication(value) {
  const clean = validateConfirmedMedication({ ...value, confirmed: true });
  if (typeof value?.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt))) throw new Error('INVALID_MEDICATION_ENTRY');
  return { ...clean, confirmedAt: value.confirmedAt };
}
