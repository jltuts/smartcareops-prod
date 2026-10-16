const clean = (value, max) => typeof value === 'string' && value.trim().length && value.trim().length <= max && !/[<>\u0000-\u001f\u007f]/.test(value)
  ? value.trim().replace(/\s+/g, ' ') : null;
const nullable = (value, max) => value === null ? null : clean(value, max);

export const labExtractionSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    documentStatus: { type: 'string', enum: ['clear', 'partial', 'unreadable'] },
    rows: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      testName: { type: ['string', 'null'] }, resultText: { type: ['string', 'null'] }, numericValue: { type: ['number', 'null'] },
      unit: { type: ['string', 'null'] }, referenceRange: { type: ['string', 'null'] }, sourceLocation: { type: ['string', 'null'] },
      uncertain: { type: 'boolean' }, unreadable: { type: 'boolean' },
    }, required: ['testName', 'resultText', 'numericValue', 'unit', 'referenceRange', 'sourceLocation', 'uncertain', 'unreadable'] } },
  }, required: ['documentStatus', 'rows'],
});

export function validateLabExtraction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'documentStatus,rows' ||
      !['clear', 'partial', 'unreadable'].includes(value.documentStatus) || !Array.isArray(value.rows) || value.rows.length > 30 ||
      (value.documentStatus === 'unreadable' && value.rows.length) || (value.documentStatus === 'clear' && !value.rows.length)) throw new Error('INVALID_LAB_EXTRACTION');
  const rows = value.rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== 'numericValue,referenceRange,resultText,sourceLocation,testName,uncertain,unit,unreadable' ||
        typeof row.uncertain !== 'boolean' || typeof row.unreadable !== 'boolean' ||
        row.numericValue !== null && (typeof row.numericValue !== 'number' || !Number.isFinite(row.numericValue))) throw new Error('INVALID_LAB_EXTRACTION');
    const parsed = { testName: nullable(row.testName, 120), resultText: nullable(row.resultText, 120), numericValue: row.numericValue,
      unit: nullable(row.unit, 80), referenceRange: nullable(row.referenceRange, 160), sourceLocation: nullable(row.sourceLocation, 120),
      uncertain: row.uncertain, unreadable: row.unreadable };
    if ([['testName', row.testName], ['resultText', row.resultText], ['unit', row.unit], ['referenceRange', row.referenceRange], ['sourceLocation', row.sourceLocation]].some(([key, original]) => original !== null && parsed[key] === null) ||
        (!parsed.testName && !parsed.unreadable) || (parsed.unreadable && !parsed.uncertain) ||
        (parsed.unreadable && (parsed.resultText !== null || parsed.numericValue !== null || parsed.unit !== null || parsed.referenceRange !== null)) ||
        (parsed.numericValue !== null && (parsed.resultText === null || !parsed.resultText.includes(String(parsed.numericValue))))) throw new Error('INVALID_LAB_EXTRACTION');
    return parsed;
  });
  if (value.documentStatus === 'clear' && rows.some(row => row.uncertain || row.unreadable || !row.testName || !row.resultText)) throw new Error('INVALID_LAB_EXTRACTION');
  if (value.documentStatus === 'partial' && !rows.some(row => row.uncertain || row.unreadable)) throw new Error('INVALID_LAB_EXTRACTION');
  return { documentStatus: value.documentStatus, rows };
}
