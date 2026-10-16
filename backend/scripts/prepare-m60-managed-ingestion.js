import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicyCorpusFixture } from '../src/agent-platform/policy-corpus-fixture.js';
import { buildManagedPolicyIngestion } from '../src/agent-platform/policy-managed-ingestion.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const insideRepository = path => { const relation = relative(repositoryRoot, path); return relation && !relation.startsWith('..') && !isAbsolute(relation); };
const option = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const [dossierInput, fixtureInput, outputInput] = process.argv.slice(2).filter(value => !value.startsWith('--'));

if (!dossierInput || !fixtureInput || !outputInput || !option('corpus') || !option('model-armor-template')) {
  console.error('Usage: node scripts/prepare-m60-managed-ingestion.js <approval.json> <fixture.json> <new-output-directory> --corpus=<resource> --model-armor-template=<resource>');
  process.exitCode = 2;
} else {
  try {
    const dossierPath = resolve(dossierInput), fixturePath = resolve(fixtureInput), outputPath = resolve(outputInput);
    if (![dossierPath, fixturePath, outputPath].every(insideRepository)) throw Object.assign(new Error(), { code: 'POLICY_PATH_INVALID' });
    const dossier = JSON.parse(await readFile(dossierPath, 'utf8'));
    const documentsByReference = Object.fromEntries(await Promise.all(dossier.documents.map(async document => {
      const path = resolve(repositoryRoot, document.sourceReference);
      if (!insideRepository(path)) throw Object.assign(new Error(), { code: 'POLICY_PATH_INVALID' });
      return [document.sourceReference, await readFile(path, 'utf8')];
    })));
    const rebuilt = buildPolicyCorpusFixture({ dossier, documentsByReference });
    const supplied = JSON.parse(await readFile(fixturePath, 'utf8'));
    if (JSON.stringify(rebuilt) !== JSON.stringify(supplied)) throw Object.assign(new Error(), { code: 'POLICY_FIXTURE_MISMATCH' });
    const bundle = buildManagedPolicyIngestion({ fixture: rebuilt, corpusResource: option('corpus'),
      modelArmorTemplate: option('model-armor-template') });
    await mkdir(outputPath);
    for (const file of bundle.files) await writeFile(join(outputPath, file.fileName), file.content, { encoding: 'utf8', flag: 'wx' });
    const manifest = { ...bundle, files: bundle.files.map(({ content: _content, ...file }) => file) };
    await writeFile(join(outputPath, 'managed-ingestion-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ status: 'prepared', outputPath, corpusResource: bundle.corpusResource,
      modelArmorTemplate: bundle.modelArmorTemplate, fileCount: bundle.files.length, manifestDigest: bundle.manifestDigest }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', code: error.code || 'POLICY_MANAGED_INGESTION_PREPARATION_FAILED' }));
    process.exitCode = 1;
  }
}
