import { validateLabExtraction } from './contracts.js';

const reviewFields = ['testName', 'resultText', 'numericValue', 'unit', 'referenceRange', 'sourceLocation'];
const invalid = () => { throw new Error('INVALID_LAB_REVIEW'); };

export function validateLabReview(input, extraction) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'confirmedOriginal,expectedReviewToken,rows' ||
      input.confirmedOriginal !== true || !/^[0-9a-f-]{36}$/i.test(input.expectedReviewToken) ||
      !Array.isArray(input.rows) || !Array.isArray(extraction?.rows) ||
      input.rows.length !== extraction.rows.length || input.rows.length > 30) invalid();

  const rows = [], excludedSourceIndexes = [], corrections = [];
  input.rows.forEach((entry, sourceIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.include !== 'boolean') invalid();
    if (!entry.include) {
      if (Object.keys(entry).join(',') !== 'include') invalid();
      excludedSourceIndexes.push(sourceIndex); return;
    }
    if (Object.keys(entry).sort().join(',') !== 'include,numericValue,referenceRange,resultText,sourceLocation,testName,unit') invalid();
    let reviewed;
    try {
      reviewed = validateLabExtraction({ documentStatus: 'clear', rows: [{
        testName: entry.testName, resultText: entry.resultText, numericValue: entry.numericValue,
        unit: entry.unit, referenceRange: entry.referenceRange, sourceLocation: entry.sourceLocation,
        uncertain: false, unreadable: false,
      }] }).rows[0];
    } catch { invalid(); }
    for (const field of reviewFields) if (extraction.rows[sourceIndex][field] !== reviewed[field]) {
      corrections.push({ sourceIndex, field, originalValue: extraction.rows[sourceIndex][field], verifiedValue: reviewed[field] });
    }
    rows.push({ sourceIndex, ...reviewed });
  });
  if (!rows.length) invalid();
  return { rows, excludedSourceIndexes, corrections };
}
