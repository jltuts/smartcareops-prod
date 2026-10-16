import { ClinicalError, exact, textValue } from '../clinical/contracts.js';

const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (condition, code) => {
  if (!condition) throw new ClinicalError(code, 409);
};

const requiredText = (value, maximum = 500) => Boolean(textValue(value, maximum));

export function validatePolicyCorpusApproval(dossier) {
  exact(dossier, [
    'schemaVersion', 'status', 'corpusId', 'version', 'manifestDigest', 'owner',
    'license', 'clinicalApproval', 'lifecycle', 'dataBoundary', 'documents',
  ]);
  fail(dossier.schemaVersion === '1.0', 'POLICY_APPROVAL_SCHEMA_UNSUPPORTED');
  fail(dossier.status === 'approved', 'POLICY_CORPUS_NOT_APPROVED');
  fail(requiredText(dossier.corpusId, 80) && requiredText(dossier.version, 80) && sha256(dossier.manifestDigest), 'POLICY_CORPUS_INVALID');

  exact(dossier.owner, ['name', 'contact']);
  fail(requiredText(dossier.owner.name, 160) && requiredText(dossier.owner.contact, 254), 'POLICY_OWNER_REQUIRED');

  exact(dossier.license, ['name', 'permittedUse', 'evidenceReference']);
  fail(requiredText(dossier.license.name, 160) && requiredText(dossier.license.permittedUse) &&
    requiredText(dossier.license.evidenceReference, 500), 'POLICY_LICENSE_REQUIRED');

  exact(dossier.clinicalApproval, ['reviewer', 'approvedAt', 'scope']);
  fail(requiredText(dossier.clinicalApproval.reviewer, 160) && timestamp(dossier.clinicalApproval.approvedAt) &&
    requiredText(dossier.clinicalApproval.scope), 'POLICY_CLINICAL_APPROVAL_REQUIRED');

  exact(dossier.lifecycle, ['effectiveAt', 'retiredAt', 'updateProcess', 'rollbackProcess']);
  fail(timestamp(dossier.lifecycle.effectiveAt) && dossier.lifecycle.retiredAt === null &&
    requiredText(dossier.lifecycle.updateProcess) && requiredText(dossier.lifecycle.rollbackProcess), 'POLICY_LIFECYCLE_INVALID');

  exact(dossier.dataBoundary, ['classification', 'policyOnly', 'prohibitedContentAttested']);
  fail(dossier.dataBoundary.classification === 'approved-clinical-policy' && dossier.dataBoundary.policyOnly === true &&
    dossier.dataBoundary.prohibitedContentAttested === true, 'POLICY_DATA_BOUNDARY_INVALID');

  fail(Array.isArray(dossier.documents) && dossier.documents.length > 0 && dossier.documents.length <= 500,
    'POLICY_DOCUMENT_INVENTORY_REQUIRED');
  const documentIds = new Set();
  for (const document of dossier.documents) {
    exact(document, ['documentId', 'title', 'version', 'contentDigest', 'sourceReference', 'effectiveAt', 'retiredAt']);
    fail(requiredText(document.documentId, 160) && !documentIds.has(document.documentId) &&
      requiredText(document.title, 300) && document.version === dossier.version && sha256(document.contentDigest) &&
      requiredText(document.sourceReference, 500) && timestamp(document.effectiveAt) && document.retiredAt === null,
    'POLICY_DOCUMENT_INVALID');
    documentIds.add(document.documentId);
  }

  return Object.freeze(structuredClone(dossier));
}
