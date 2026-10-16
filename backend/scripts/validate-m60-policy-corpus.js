import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validatePolicyCorpusApproval } from '../src/agent-platform/policy-corpus-approval.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/validate-m60-policy-corpus.js <approval-dossier.json>');
  process.exitCode = 2;
} else {
  try {
    const path = resolve(input);
    const dossier = JSON.parse(await readFile(path, 'utf8'));
    const approved = validatePolicyCorpusApproval(dossier);
    console.log(JSON.stringify({
      status: 'approved',
      corpusId: approved.corpusId,
      version: approved.version,
      documentCount: approved.documents.length,
      path,
    }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', code: error.code || 'POLICY_APPROVAL_FILE_INVALID' }));
    process.exitCode = 1;
  }
}
