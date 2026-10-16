import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicyCorpusFixture } from '../src/agent-platform/policy-corpus-fixture.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const insideRepository = path => {
  const relation = relative(repositoryRoot, path);
  return relation && !relation.startsWith('..') && !isAbsolute(relation);
};

const [dossierInput, outputInput] = process.argv.slice(2);
if (!dossierInput || !outputInput) {
  console.error('Usage: node scripts/prepare-m60-policy-corpus.js <approval-dossier.json> <fixture.json>');
  process.exitCode = 2;
} else {
  try {
    const dossierPath = resolve(dossierInput);
    const outputPath = resolve(outputInput);
    if (!insideRepository(dossierPath) || !insideRepository(outputPath)) throw Object.assign(new Error(), { code: 'POLICY_PATH_INVALID' });
    const dossier = JSON.parse(await readFile(dossierPath, 'utf8'));
    const documentsByReference = Object.fromEntries(await Promise.all(dossier.documents.map(async document => {
      const path = resolve(repositoryRoot, document.sourceReference);
      if (!insideRepository(path)) throw Object.assign(new Error(), { code: 'POLICY_PATH_INVALID' });
      return [document.sourceReference, await readFile(path, 'utf8')];
    })));
    const fixture = buildPolicyCorpusFixture({ dossier, documentsByReference });
    await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ status: 'prepared', corpusId: fixture.corpusId, version: fixture.version,
      documentCount: dossier.documents.length, chunkCount: fixture.chunks.length, outputPath }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', code: error.code || 'POLICY_FIXTURE_PREPARATION_FAILED' }));
    process.exitCode = 1;
  }
}
