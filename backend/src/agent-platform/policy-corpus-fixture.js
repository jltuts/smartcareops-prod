import { createHash } from 'node:crypto';
import { ClinicalError } from '../clinical/contracts.js';
import { validatePolicyCorpusApproval } from './policy-corpus-approval.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (condition, code) => {
  if (!condition) throw new ClinicalError(code, 409);
};

function sections(markdown) {
  fail(typeof markdown === 'string' && markdown.length > 0, 'POLICY_DOCUMENT_INVALID');
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  fail(matches.length > 0, 'POLICY_DOCUMENT_SECTIONS_REQUIRED');
  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? markdown.length;
    const passage = markdown.slice(start, end).trim();
    fail(passage.length > 0 && passage.length <= 1500, 'POLICY_PASSAGE_INVALID');
    return { section: match[1].trim(), passage };
  });
}

export function buildPolicyCorpusFixture({ dossier, documentsByReference }) {
  const approved = validatePolicyCorpusApproval(dossier);
  fail(documentsByReference && typeof documentsByReference === 'object' && !Array.isArray(documentsByReference),
    'POLICY_DOCUMENT_INVENTORY_REQUIRED');
  const chunks = [];
  for (const document of approved.documents) {
    const markdown = documentsByReference[document.sourceReference];
    fail(typeof markdown === 'string' && digest(markdown) === document.contentDigest, 'POLICY_DOCUMENT_DIGEST_MISMATCH');
    sections(markdown).forEach(({ section, passage }, index) => chunks.push({
      evidenceRef: `POLICY-${document.documentId}-${String(index + 1).padStart(2, '0')}`,
      documentId: document.documentId,
      version: document.version,
      section,
      contentDigest: document.contentDigest,
      passage,
    }));
  }
  fail(chunks.length > 0 && new Set(chunks.map(chunk => chunk.evidenceRef)).size === chunks.length,
    'POLICY_FIXTURE_INVALID');
  return Object.freeze({
    schemaVersion: '1.0',
    corpusId: approved.corpusId,
    version: approved.version,
    manifestDigest: approved.manifestDigest,
    chunks,
  });
}
