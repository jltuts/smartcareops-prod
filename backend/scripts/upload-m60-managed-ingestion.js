import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCleanModelArmorInspection, requireEmptyManagedCorpus,
  validateManagedCorpusPrefix, validateManagedPolicyBundle,
  validateRagFileUploadResponse } from '../src/agent-platform/policy-managed-ingestion.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const insideRepository = path => { const relation = relative(repositoryRoot, path); return relation && !relation.startsWith('..') && !isAbsolute(relation); };
const args = process.argv.slice(2);
const bundleInput = args.find(value => !value.startsWith('--'));
const execute = args.includes('--execute');
const receiptInput = args.find(value => value.startsWith('--receipt='))?.slice('--receipt='.length);
const resumeInput = args.find(value => value.startsWith('--resume='))?.slice('--resume='.length);

async function responseJson(response, code) {
  if (!response.ok) throw Object.assign(new Error(), { code, status: response.status });
  try { return await response.json(); } catch { throw Object.assign(new Error(), { code: `${code}_INVALID_RESPONSE` }); }
}

const resourceParts = resource => {
  const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/(ragCorpora|templates)\/([^/]+)$/);
  if (!match) throw Object.assign(new Error(), { code: 'POLICY_INGESTION_RESOURCE_INVALID' });
  return { project: match[1], location: match[2], id: match[4] };
};

function matchedFilterPaths(value, path = 'sanitizationResult') {
  if (!value || typeof value !== 'object') return [];
  const matches = value.filterMatchState === 'MATCH_FOUND' || value.matchState === 'MATCH_FOUND' ? [path] : [];
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'filterMatchState' && key !== 'matchState') matches.push(...matchedFilterPaths(child, `${path}.${key}`));
  }
  return matches;
}

async function loadBundle(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'managed-ingestion-manifest.json'), 'utf8'));
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile()) || entries.some(entry => entry.name !== 'managed-ingestion-manifest.json' && !entry.name.endsWith('.md')))
    throw Object.assign(new Error(), { code: 'POLICY_INGESTION_FILE_INVENTORY_MISMATCH' });
  const contents = Object.fromEntries(await Promise.all(manifest.files.map(async file => [file.fileName, await readFile(join(directory, file.fileName), 'utf8')])));
  validateManagedPolicyBundle(manifest, contents);
  if (entries.length !== manifest.files.length + 1) throw Object.assign(new Error(), { code: 'POLICY_INGESTION_FILE_INVENTORY_MISMATCH' });
  return { manifest, contents };
}

function accessToken(project) {
  const arguments_ = ['auth', 'print-access-token', `--project=${project}`];
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'gcloud';
  const commandArguments = process.platform === 'win32' ? ['/d', '/s', '/c', 'gcloud.cmd', ...arguments_] : arguments_;
  const result = spawnSync(command, commandArguments, { encoding: 'utf8', windowsHide: true });
  const token = result.status === 0 ? result.stdout.trim() : '';
  if (!token) throw Object.assign(new Error(), {
    code: 'POLICY_INGESTION_TOKEN_UNAVAILABLE',
    authDiagnostic: {
      exitCode: result.status,
      launchError: result.error?.code || null,
      stderr: result.stderr?.trim().slice(0, 1000) || null,
    },
  });
  return token;
}

async function run() {
  if (!bundleInput || (execute && !receiptInput)) {
    console.error('Usage: node scripts/upload-m60-managed-ingestion.js <bundle-directory> [--execute --receipt=<new-receipt.json> [--resume=<partial-receipt.json>]]');
    process.exitCode = 2; return;
  }
  const bundlePath = resolve(bundleInput), receiptPath = receiptInput ? resolve(receiptInput) : null;
  const resumePath = resumeInput ? resolve(resumeInput) : null;
  if (!insideRepository(bundlePath) || (receiptPath && !insideRepository(receiptPath)) ||
    (resumePath && !insideRepository(resumePath))) throw Object.assign(new Error(), { code: 'POLICY_PATH_INVALID' });
  const { manifest, contents } = await loadBundle(bundlePath);
  const corpus = resourceParts(manifest.corpusResource), template = resourceParts(manifest.modelArmorTemplate);
  if (corpus.project !== template.project || corpus.location !== template.location) throw Object.assign(new Error(), { code: 'POLICY_INGESTION_REGION_MISMATCH' });
  const plan = { status: execute ? 'executing' : 'reviewed', mutation: execute, project: corpus.project, location: corpus.location,
    corpusResource: manifest.corpusResource, modelArmorTemplate: manifest.modelArmorTemplate, corpusVersion: manifest.version,
    manifestDigest: manifest.manifestDigest, fileCount: manifest.files.length,
    safeguards: ['exact bundle digests', 'empty corpus required', 'all Model Armor inspections before upload', 'no Patient data'] };
  if (!execute) { console.log(JSON.stringify(plan)); return; }

  const token = accessToken(corpus.project), headers = { Authorization: `Bearer ${token}` };
  const apiRoot = `https://${corpus.location}-aiplatform.googleapis.com`;
  const list = await responseJson(await fetch(`${apiRoot}/v1beta1/${manifest.corpusResource}/ragFiles?pageSize=100`, { headers }), 'POLICY_CORPUS_LIST_FAILED');
  let existing = [];
  if (resumePath) {
    const partial = JSON.parse(await readFile(resumePath, 'utf8'));
    if (partial.status !== 'partial' || partial.corpusResource !== manifest.corpusResource ||
      partial.corpusVersion !== manifest.version || partial.manifestDigest !== manifest.manifestDigest ||
      !Array.isArray(partial.uploaded)) throw Object.assign(new Error(), { code: 'POLICY_CORPUS_RESUME_RECEIPT_INVALID' });
    existing = validateManagedCorpusPrefix(manifest.files, list.ragFiles ?? []);
  } else {
    requireEmptyManagedCorpus(list);
  }

  const inspectionUrl = `https://modelarmor.${template.location}.rep.googleapis.com/v1/${manifest.modelArmorTemplate}:sanitizeUserPrompt`;
  for (const file of manifest.files) {
    const response = await fetch(inspectionUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userPromptData: { text: contents[file.fileName] } }) });
    const inspection = await responseJson(response, 'POLICY_MODEL_ARMOR_REQUEST_FAILED');
    try {
      requireCleanModelArmorInspection(inspection);
    } catch (error) {
      error.policyDiagnostic = { evidenceRef: file.evidenceRef, fileName: file.fileName,
        invocationResult: inspection.sanitizationResult?.invocationResult || null,
        filterMatchState: inspection.sanitizationResult?.filterMatchState || null,
        matchedFilters: matchedFilterPaths(inspection.sanitizationResult) };
      throw error;
    }
  }

  const uploaded = [...existing];
  try {
    for (const file of manifest.files.slice(existing.length)) {
      const form = new FormData();
      form.append('metadata', JSON.stringify({ rag_file: { display_name: file.displayName, description: file.description } }));
      form.append('file', new Blob([contents[file.fileName]], { type: 'text/markdown' }), basename(file.fileName));
      const response = await fetch(`${apiRoot}/upload/v1beta1/${manifest.corpusResource}/ragFiles:upload`, {
        method: 'POST', headers: { ...headers, 'X-Goog-Upload-Protocol': 'multipart' }, body: form,
      });
      const result = await responseJson(response, 'POLICY_RAG_UPLOAD_FAILED');
      const ragFile = validateRagFileUploadResponse(result, file.displayName);
      uploaded.push({ evidenceRef: file.evidenceRef, fileDigest: file.fileDigest, ragFile: ragFile.name, displayName: ragFile.displayName });
    }
    const receipt = { schemaVersion: '1.0', status: 'uploaded', project: corpus.project, location: corpus.location,
      corpusResource: manifest.corpusResource, corpusVersion: manifest.version, manifestDigest: manifest.manifestDigest,
      modelArmorTemplate: manifest.modelArmorTemplate, inspectedFileCount: manifest.files.length, uploaded };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ status: receipt.status, receiptPath, fileCount: uploaded.length, corpusResource: manifest.corpusResource }));
  } catch (error) {
    const partial = { schemaVersion: '1.0', status: 'partial', corpusResource: manifest.corpusResource,
      corpusVersion: manifest.version, manifestDigest: manifest.manifestDigest, uploaded, failureCode: error.code || 'POLICY_RAG_UPLOAD_FAILED' };
    try { await writeFile(receiptPath, `${JSON.stringify(partial, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); } catch { /* Preserve the original bounded failure. */ }
    throw error;
  }
}

run().catch(error => {
  console.error(JSON.stringify({ status: 'blocked', code: error.code || 'POLICY_MANAGED_INGESTION_FAILED',
    ...(error.status ? { httpStatus: error.status } : {}), ...(error.authDiagnostic ? { authDiagnostic: error.authDiagnostic } : {}),
    ...(error.policyDiagnostic ? { policyDiagnostic: error.policyDiagnostic } : {}) }));
  process.exitCode = 1;
});
