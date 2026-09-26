// Explicit opt-in diagnostic only: node backend/scripts/repro-computer-use-wire.js --run
// No intake, hospital form, handoff capability, or production runtime imports.
import { GoogleGenAI } from '@google/genai';
import { chromium } from 'playwright';
import { loadEnvFile } from 'node:process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { safeApiError } from '../src/agent/api-diagnostics.js';
import { sanitizedWireBody, wireImageFacts } from './computer-use-wire-view.js';

const model = 'gemini-3.8-flash';
const tools = [{ type: 'computer_use', environment: 'browser', enable_prompt_injection_detection: true }];
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const system_instruction = 'Operate only this local diagnostic page. Click the blue diagnostic button once, using one click action, then report the visible result. Do not navigate, enter text, or perform any other action.';
const print = (stage, fields) => console.log('[agent-wire]', JSON.stringify({ stage, ...fields }));

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Diagnostic disabled in production.');
  try { loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.env.NODE_ENV === 'production') throw new Error('Diagnostic disabled in production.');
  if (!process.env.GEMINI_API_KEY) throw new Error('API key is not configured.');
  const pkg = JSON.parse(await readFile(new URL('../node_modules/@google/genai/package.json', import.meta.url), 'utf8'));
  print('setup', { sdkVersion: pkg.version, model, diagnosticOnly: true });
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const originalFetch = globalThis.fetch;
  let label = 'initial', publicBody;
  const wireBodies = new Map();
  const storedIds = new Set();
  let browser;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>Local Computer Use Diagnostic</title><style>body{font:28px Arial;text-align:center;padding:100px}button{font:32px Arial;padding:40px;background:#165cdd;color:white;border:0}p{margin:40px}</style></head><body><h1>Local diagnostic only</h1><button onclick="document.querySelector(\'p\').textContent=\'CLICK RECEIVED\'">Diagnostic button</button><p>Waiting for one click</p></body></html>');
  });
  // The SDK's DEFAULT_FETCHER calls global fetch with the final Request object.
  // This hook exists only in this isolated process, and filters this exact API.
  globalThis.fetch = async (resource, init) => {
    const request = resource instanceof Request && init === undefined ? resource : new Request(resource, init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.origin === 'https://generativelanguage.googleapis.com' && url.pathname === '/v1beta/interactions') {
      const body = JSON.parse(await request.clone().text());
      if (body.model === model && body.tools?.some(tool => tool.type === 'computer_use')) {
        wireBodies.set(label, body); // In-memory only, never written to disk.
        print('outbound_http_json', { control: label, endpointPath: url.pathname, inputMatchesPublicObject: isDeepStrictEqual(body.input, publicBody?.input), bodyMatchesPublicObject: isDeepStrictEqual(body, publicBody), body: sanitizedWireBody(body), ...wireImageFacts(body) });
      }
    }
    return originalFetch(resource, init);
  };
  const sdk = async (control, body) => {
    label = control; publicBody = body;
    print('public_sdk_object', { control, body: sanitizedWireBody(body) });
    try {
      const result = await ai.interactions.create(body, { signal: AbortSignal.timeout(60000), maxRetries: 0 });
      if (body.store !== false && typeof result.id === 'string') storedIds.add(result.id);
      print('response', { control, succeeded: true, functionCallCount: result.steps?.filter(step => step.type === 'function_call').length ?? 0, hasModelOutput: result.steps?.some(step => step.type === 'model_output') ?? false });
      return { succeeded: true, result };
    } catch (error) {
      const safe = safeApiError(error);
      print('response', { control, succeeded: false, ...safe });
      return { succeeded: false, error: safe };
    }
  };
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const localUrl = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ headless: true, channel: process.env.COMPUTER_USE_BROWSER_CHANNEL || 'msedge', chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url() === localUrl ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(localUrl);
    const shot = async () => ({ type: 'image', mime_type: 'image/png', data: (await page.screenshot({ type: 'png' })).toString('base64') });
    const firstInput = [{ type: 'user_input', content: [{ type: 'text', text: 'Click the Diagnostic button once, then read the result. This is a harmless local test.' }, await shot()] }];
    // Share one stored initial response so both controls use byte-identical call
    // IDs, names, model steps, action result and post-action screenshot.
    const first = await sdk('initial_shared', { model, tools, system_instruction, store: true, input: firstInput });
    if (!first.succeeded) return;
    const calls = first.result.steps?.filter(step => step.type === 'function_call');
    if (calls?.length !== 1 || calls[0].name !== 'click') { print('action', { executed: false, reason: 'Expected exactly one harmless click.' }); return; }
    const call = calls[0], args = call.arguments;
    if (!args || ![args.x, args.y].every(value => Number.isInteger(value) && value >= 0 && value <= 999) || (args.safety_decision && !['allowed', 'regular'].includes(args.safety_decision.decision))) { print('action', { executed: false, reason: 'Action was not safely executable without confirmation.' }); return; }
    await page.mouse.click(Math.floor(args.x / 1000 * 1280), Math.floor(args.y / 1000 * 960));
    const result = { type: 'function_result', name: call.name, call_id: call.id, result: [{ type: 'text', text: JSON.stringify({ url: page.url() }) }, await shot()] };
    print('action', { executed: true, clickRegistered: await page.locator('p').innerText() === 'CLICK RECEIVED', callIdMatches: result.call_id === call.id, nameMatches: result.name === call.name, safetyAcknowledgementRequired: false });
    const statelessBody = { model, tools, system_instruction, store: false, input: [...firstInput, ...first.result.steps, result] };
    const a = await sdk('A_stateless', statelessBody);
    const b = await sdk('B_previous_interaction_id', { model, tools, system_instruction, store: true, previous_interaction_id: first.result.id, input: [result] });
    print('control_comparison', { identicalFunctionResult: isDeepStrictEqual(wireBodies.get('A_stateless')?.input.at(-1), wireBodies.get('B_previous_interaction_id')?.input.at(-1)), statelessSucceeded: a.succeeded, previousInteractionSucceeded: b.succeeded });
    if (!a.succeeded && !b.succeeded) {
      // ONE raw REST control, using the same documented stateless body. No SDK,
      // extra image nesting, alternate model, or automatic retry is involved.
      label = 'C_raw_rest'; publicBody = statelessBody;
      const response = await globalThis.fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(statelessBody), signal: AbortSignal.timeout(60000) });
      const body = await response.json();
      print('response', { control: label, succeeded: response.ok, ...(response.ok ? { functionCallCount: body.steps?.filter(step => step.type === 'function_call').length ?? 0 } : safeApiError({ status: response.status, body })) });
      print('rest_comparison', { sdkAndRestBodiesIdentical: isDeepStrictEqual(wireBodies.get('A_stateless'), wireBodies.get('C_raw_rest')) });
    }
  } finally {
    globalThis.fetch = originalFetch;
    // Delete only interactions created by this standalone diagnostic.
    for (const id of [...storedIds].reverse()) {
      try { await ai.interactions.delete(id, {}, { signal: AbortSignal.timeout(10000), maxRetries: 0 }); print('cleanup', { storedInteractionDeleted: true }); }
      catch (error) { print('cleanup', { storedInteractionDeleted: false, ...safeApiError(error) }); }
    }
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    wireBodies.clear();
  }
}

if (process.argv.includes('--run')) {
  main().catch(error => { print('diagnostic_failed', safeApiError(error)); process.exitCode = 1; });
} else console.log('Diagnostic only. Run explicitly with: node backend/scripts/repro-computer-use-wire.js --run');
