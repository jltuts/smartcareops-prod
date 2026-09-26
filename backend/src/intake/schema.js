export const redFlagTypes = ['current chest pain', 'severe difficulty breathing', 'loss of consciousness', 'stroke-like symptoms', 'severe uncontrolled bleeding'];
export const kinds = ['name', 'preferredName', 'symptom', 'redFlag', 'onset', 'temperature', 'bloodPressure', 'heartRate', 'spo2', 'bloodGlucose', 'note'];

export function emptyIntake() {
  return {
    patient: { name: null, preferredName: null },
    symptoms: [],
    onset: { value: null, patientReportedText: '' },
    vitals: {
      temperature: { value: null, unit: null, source: null },
      bloodPressure: { systolic: null, diastolic: null, source: null },
      heartRate: { value: null, unit: 'bpm', source: null },
      spo2: { value: null, unit: '%', source: null },
      bloodGlucose: { value: null, unit: null, qualitative: null, source: null },
    },
    redFlags: [], additionalNotes: [], evidence: {},
  };
}

// Updates, not a replacement object. Every update must cite a patient utterance.
export const patchSchema = {
  type: 'object', additionalProperties: false, required: ['updates'],
  properties: { updates: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote'],
    properties: {
      kind: { type: 'string', enum: kinds },
      label: { type: 'string', description: 'For symptom: a literal symptom phrase copied from the patient utterance, or from one simple immediately preceding question answered briefly. Never canonicalize or use a diagnostic/clinical synonym. For redFlag: the existing closed evidence-grounded label. Empty for other kinds.' },
      value: { type: 'string' },
      secondaryValue: { type: 'string' },
      unit: { type: 'string' },
      qualitative: { type: 'string' },
      status: { type: 'string', description: 'For symptom/redFlag: confirmed, denied, or unclear. Empty for other kinds.' },
      evidenceId: { type: 'integer' }, quote: { type: 'string', description: 'Exact quote copied from the cited patient utterance.' },
    },
  } } },
};

// Normalize the flat wire schema before evidence-aware validation. Preserve unknown
// keys so the validator rejects them instead of hiding prohibited model output.
export const normalizationFailure = Symbol('normalizationFailure');
const wireFields = ['kind', 'label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote'];
const safeFieldNames = names => names.filter(name => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)).slice(0, 12);
function shapeFailure(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.assign(new Error('Invalid extraction update'), {
    reason: 'invalid schema', field: 'update', expected: 'object', receivedType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
  });
  const keys = Object.keys(raw);
  const missingFields = wireFields.filter(key => !Object.hasOwn(raw, key));
  const unexpectedFields = safeFieldNames(keys.filter(key => !wireFields.includes(key)));
  if (missingFields.length || unexpectedFields.length || keys.length !== new Set(keys).size) return Object.assign(new Error('Invalid extraction update shape'), {
    reason: 'invalid schema', field: 'update', expected: 'exact extraction update shape', receivedType: 'object', missingFields, unexpectedFields,
  });
  return null;
}
export function normalizePatch(patch, { independent = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'updates') || !Array.isArray(patch.updates) || patch.updates.length > 24) {
    throw Object.assign(new Error('Invalid extraction'), { reason: 'invalid schema', field: 'response', expected: '{ updates: array }', receivedType: patch === null ? 'null' : Array.isArray(patch) ? 'array' : typeof patch });
  }
  return { ...patch, updates: patch.updates.map(raw => {
    try {
    const shapeError = shapeFailure(raw);
    if (shapeError) throw shapeError;
    const item = { ...raw };
    for (const key of ['label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status']) {
      if (typeof item[key] !== 'string') throw Object.assign(new Error('Invalid extraction field'), { reason: 'invalid schema', field: key, expected: 'string', receivedType: item[key] === null ? 'null' : typeof item[key] });
      if (item[key] === '') item[key] = null;
    }
    for (const key of ['value', 'secondaryValue']) {
      if (item[key] !== null && (key === 'secondaryValue' || ['temperature', 'bloodPressure', 'heartRate', 'spo2', 'bloodGlucose'].includes(item.kind))) {
        if (!/^-?\d+(?:\.\d+)?$/.test(item[key])) throw Object.assign(new Error('Invalid reported number'), { reason: 'invalid schema', field: key, expected: 'numeric string', receivedType: typeof item[key] });
        item[key] = Number(item[key]);
      }
    }
    return item;
    } catch (error) {
      if (!independent) throw error;
      return Object.defineProperty({ ...raw }, normalizationFailure, { value: error });
    }
  }) };
}
