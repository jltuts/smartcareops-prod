// Standalone opt-in control. No production loop, intake or hospital form imports.
// node backend/scripts/repro-generate-content-computer-use.js --run
import { GoogleGenAI, Environment } from '@google/genai';
import { chromium } from 'playwright';
import { loadEnvFile } from 'node:process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { safeApiError } from '../src/agent/api-diagnostics.js';
import { sanitizedWireBody, wireImageFacts } from './computer-use-wire-view.js';

const model = 'gemini-3.8-flash';
const print = (stage, detail) => console.log('[agent-generate-content]', JSON.stringify({ stage, ...detail }));
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Diagnostic disabled.');
  try { loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.env.NODE_ENV === 'production' || !process.env.GEMINI_API_KEY) throw new Error('Diagnostic unavailable.');
  const pkg = JSON.parse(await readFile(new URL('../node_modules/@google/genai/package.json', import.meta.url), 'utf8'));
  print('setup', { sdkVersion: pkg.version, model, diagnosticOnly: true });
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const originalFetch = globalThis.fetch;
  let round = 0, browser, actionsExecuted = 0;
  globalThis.fetch = async (resource, init) => {
    const request = resource instanceof Request && init === undefined ? resource : new Request(resource, init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.origin === 'https://generativelanguage.googleapis.com' && url.pathname === `/v1beta/models/${model}:generateContent`) {
      const body = JSON.parse(await request.clone().text());
      print('outbound_http_json', { round, endpointPath: url.pathname, body: sanitizedWireBody(body), ...wireImageFacts(body) });
    }
    return originalFetch(resource, init);
  };
  // Identical local page to the Interactions control; only the task asks for
  // two clicks in separate turns, so a third API request can be demonstrated.
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>Local Computer Use Diagnostic</title><style>body{font:28px Arial;text-align:center;padding:100px}button{font:32px Arial;padding:40px;background:#165cdd;color:white;border:0}p{margin:40px}</style></head><body><h1>Local diagnostic only</h1><button onclick="document.querySelector(\'p\').textContent=\'CLICK RECEIVED\'">Diagnostic button</button><p>Waiting for one click</p></body></html>');
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const localUrl = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ headless: true, channel: process.env.COMPUTER_USE_BROWSER_CHANNEL || 'msedge', chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url() === localUrl ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(localUrl);
    /** @returns {Promise<import('@google/genai').FunctionResponsePart>} */
    const shot = async () => ({ inlineData: { mimeType: 'image/png', data: (await page.screenshot({ type: 'png' })).toString('base64') } });
    /** @type {import('@google/genai').Content[]} */
    const contents = [{ role: 'user', parts: [{ text: 'Click the Diagnostic button exactly twice, one click action per model turn. Wait for the screenshot after your first click before requesting the second click. After the second screenshot, report the visible result. This is a harmless local test.' }, await shot()] }];
    /** @type {import('@google/genai').GenerateContentConfig} */
    const config = {
      systemInstruction: 'Operate only this local diagnostic page. Use one click action per turn. Do not navigate, type, or interact with anything except the blue Diagnostic button.',
      tools: [{ computerUse: { environment: Environment.ENVIRONMENT_BROWSER, enablePromptInjectionDetection: true } }],
      thinkingConfig: { includeThoughts: true },
      httpOptions: { timeout: 60000 },
    };
    for (round = 1; round <= 3; round++) {
      print('request_started', { round, model });
      let response;
      try { response = await ai.models.generateContent({ model, contents, config }); }
      catch (error) {
        // GenerateContent ApiError carries JSON in message; parse it privately
        // and pass it through the same strict allowlist as Interactions errors.
        let body;
        try { if (typeof error.message === 'string' && error.message.length < 32000) body = JSON.parse(error.message); } catch {}
        print('response', { round, succeeded: false, ...safeApiError({ status: error.status, body }) });
        process.exitCode = 1; return;
      }
      const content = response.candidates?.[0]?.content;
      const calls = content?.parts?.filter(part => part.functionCall).map(part => part.functionCall) || [];
      print('response', { round, succeeded: true, functionCallCount: calls.length, actions: calls.map(call => call.name === 'click' ? 'click' : '[other action]'), hasText: content?.parts?.some(part => typeof part.text === 'string' && !part.thought) ?? false });
      if (round === 3) break;
      if (calls.length !== 1 || calls[0].name !== 'click') { print('stopped', { round, reason: 'Expected exactly one harmless click.' }); process.exitCode = 1; return; }
      const call = calls[0], args = call.args;
      if (!args || ![args.x, args.y].every(value => Number.isInteger(value) && value >= 0 && value <= 999) || (args.safety_decision && !['allowed', 'regular'].includes(args.safety_decision.decision))) { print('stopped', { round, reason: 'Action requires confirmation or is not safely executable.' }); process.exitCode = 1; return; }
      if (page.url() !== localUrl || context.pages().length !== 1) throw new Error('Local page changed.');
      await page.mouse.click(Math.floor(args.x / 1000 * 1280), Math.floor(args.y / 1000 * 960));
      actionsExecuted++;
      // Preserve complete model content, including opaque thought signatures.
      contents.push(content);
      /** @type {import('@google/genai').FunctionResponse} */
      const functionResponse = { name: call.name, ...(typeof call.id === 'string' ? { id: call.id } : {}), response: { url: page.url() }, parts: [await shot()] };
      contents.push({ role: 'user', parts: [{ functionResponse }] });
      print('action', { round, executed: true, clickRegistered: await page.locator('p').innerText() === 'CLICK RECEIVED', nameMatches: functionResponse.name === call.name, callIdPresent: typeof call.id === 'string', callIdPreserved: functionResponse.id === call.id, functionResponse: sanitizedWireBody(functionResponse) });
    }
    print('completed', { successfulRequests: round, actionsExecuted, controlSucceeded: round === 3 && actionsExecuted === 2 });
  } finally {
    globalThis.fetch = originalFetch;
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv.includes('--run')) main().catch(() => { print('diagnostic_failed', { message: 'Diagnostic setup or local execution failed; raw details omitted.' }); process.exitCode = 1; });
else console.log('Run explicitly: node backend/scripts/repro-generate-content-computer-use.js --run');
