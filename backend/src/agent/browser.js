import { tagAgentError } from './diagnostics.js';
import { HandoffError } from './errors.js';
import { setTimeout as delay } from 'node:timers/promises';

export const viewport = { width: 1280, height: 960 };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, max = 999) => Number.isInteger(value) && value >= 0 && value <= max;
const keys = ['Tab', 'Shift+Tab', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const allowed = {
  click: ['x', 'y'], double_click: ['x', 'y'], type: ['text', 'press_enter'],
  press_key: ['key'], hotkey: ['keys'], scroll: ['x', 'y', 'direction', 'magnitude_in_pixels'],
  wait: ['seconds'], take_screenshot: [], navigate: ['url'],
  populate_validated_intake: ['observed_form'],
};
export function validateAction(call, portalUrl) {
  if (!object(call) || call.type !== 'function_call' || typeof call.id !== 'string' || !call.id || !Object.hasOwn(allowed, call.name) || !object(call.arguments)) throw new HandoffError('Unsupported browser action was blocked.');
  const a = call.arguments;
  if (call.name === 'populate_validated_intake' && a.observed_form !== 'fictional_hospital_intake') throw new HandoffError('Expected fictional form was not visually confirmed.');
  if (Object.keys(a).some(key => ![...allowed[call.name], 'intent', 'safety_decision'].includes(key))) throw new HandoffError('Unsupported action arguments were blocked.');
  if (a.intent !== undefined && (typeof a.intent !== 'string' || a.intent.length > 1000)) throw new HandoffError('Invalid action intent.');
  if (a.safety_decision !== undefined && (!object(a.safety_decision) || !['allowed', 'regular', 'require_confirmation'].includes(a.safety_decision.decision))) throw new HandoffError('Action blocked by safety policy.');
  if (['click', 'double_click', 'scroll'].includes(call.name) && (!integer(a.x) || !integer(a.y))) throw new HandoffError('Invalid browser coordinates.');
  if (call.name === 'navigate' && a.url !== portalUrl) throw new HandoffError('Navigation outside the hospital demo was blocked.');
  if (call.name === 'type' && (typeof a.text !== 'string' || a.text.length > 8000 || (a.press_enter !== undefined && typeof a.press_enter !== 'boolean'))) throw new HandoffError('Invalid text action.');
  if (call.name === 'press_key' && !keys.includes(a.key)) throw new HandoffError('Unsupported keyboard action was blocked.');
  if (call.name === 'hotkey' && JSON.stringify(a.keys) !== JSON.stringify(['Control', 'A'])) throw new HandoffError('Unsupported keyboard shortcut was blocked.');
  if (call.name === 'scroll' && (!['up', 'down', 'left', 'right'].includes(a.direction) || (a.magnitude_in_pixels !== undefined && !integer(a.magnitude_in_pixels)))) throw new HandoffError('Invalid scroll action.');
  if (call.name === 'wait' && a.seconds !== undefined && !integer(a.seconds, 5)) throw new HandoffError('Invalid wait action.');
  return call;
}

export async function openBrowser({ portalUrl, signal, onBlocked, diagnostic = () => {}, headless = process.env.COMPUTER_USE_HEADLESS === 'true', channel = process.env.COMPUTER_USE_BROWSER_CHANNEL }) {
  const url = new URL(portalUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hospital-demo' || url.search || url.hash || url.username || url.password) throw new HandoffError('Invalid local portal configuration.');
  const { chromium } = await import('playwright');
  signal.throwIfAborted();
  const browser = await chromium.launch({ headless, ...(channel ? { channel } : {}), chromiumSandbox: true, timeout: 20000 });
  diagnostic('browser_launch', 'SUCCEEDED');
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await browser.close(); } };
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ viewport, acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(10000);
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.url() === portalUrl && request.method() === 'GET' && request.isNavigationRequest() && request.frame() === page.mainFrame()) await route.continue();
      else { await route.abort(); onBlocked('Browser network request outside the portal was blocked.'); }
    });
    const page = await context.newPage();
    context.on('page', other => { if (other !== page) { void other.close(); onBlocked('Opening another tab was blocked.'); } });
    page.on('download', download => { void download.cancel(); onBlocked('Download was blocked.'); });
    page.on('dialog', dialog => { void dialog.dismiss(); onBlocked('Unexpected dialog was blocked.'); });
    page.on('filechooser', () => onBlocked('File access was blocked.'));
    await context.routeWebSocket('**/*', socket => { socket.close(); onBlocked('Browser WebSocket was blocked.'); });
    diagnostic('portal_navigation', 'STARTED');
    await page.goto(portalUrl);
    diagnostic('portal_navigation', 'SUCCEEDED');
    signal.throwIfAborted();
    const check = () => { signal.throwIfAborted(); if (page.url() !== portalUrl || context.pages().length !== 1) throw tagAgentError(new HandoffError('Browser left the allowed portal.'), 'PORTAL_STATE_MISMATCH'); };
    let populationAttempted = false;
    return {
      close,
      async screenshot() { check(); return page.screenshot({ type: 'png', fullPage: false }); },
      async populateValidated(expected) {
        check();
        if (populationAttempted) throw new HandoffError('Hospital population was already attempted.');
        const names = ['Patient Name', 'Reported Symptoms', 'Onset / Duration', 'Shortness of Breath', 'Chest Pain', 'Blood Pressure', 'Temperature', 'Heart Rate', 'SpO2', 'Blood Glucose', 'Notes'];
        if (JSON.stringify(Object.keys(expected)) !== JSON.stringify(names) || names.some(name => typeof expected[name] !== 'string' || expected[name].length > (name === 'Notes' ? 8000 : 4000))) throw new HandoffError('Invalid validated form data.');
        if (await page.title() !== 'Hospital Intake Demo' || !await page.locator('#intake-form').isVisible() || await page.locator('#receipt').isVisible()) throw new HandoffError('Unexpected hospital form state.');
        const actual = await page.locator('#intake-form').evaluate(form => ({ names: [...form.querySelectorAll('input, textarea, select')].map(el => el.name), submits: form.querySelectorAll('button[type="submit"]').length, action: form.getAttribute('action') }));
        if (JSON.stringify(actual.names) !== JSON.stringify(names) || actual.submits !== 1 || actual.action !== null) throw new HandoffError('Hospital form contract changed.');
        for (const name of names) {
          check(); const field = page.getByLabel(name, { exact: true });
          if (!await field.isVisible() || !await field.isEditable() || await field.inputValue() !== '') throw new HandoffError('Expected an empty editable hospital field.');
        }
        // A partial fill must also fail closed: never retry over mutated fields.
        populationAttempted = true;
        for (const name of names) { check(); await page.getByLabel(name, { exact: true }).fill(expected[name]); }
        for (const name of names) { check(); if (await page.getByLabel(name, { exact: true }).inputValue() !== expected[name]) throw new HandoffError('Hospital field verification failed.'); }
        if (await page.locator('#receipt').isVisible()) throw new HandoffError('Unexpected submission during population.');
        await page.evaluate(() => window.scrollTo(0, 0));
        return { fieldsVerified: names.length };
      },
      async execute(call) {
        check(); validateAction(call, portalUrl);
        if (call.name === 'populate_validated_intake') throw new HandoffError('Population requires the visual confirmation gate.');
        const a = call.arguments;
        const x = Math.floor(a.x / 1000 * viewport.width), y = Math.floor(a.y / 1000 * viewport.height);
        if (['click', 'double_click', 'press_key'].includes(call.name) && await page.evaluate(({ x, y, enter }) => {
          const target = enter ? document.activeElement : document.elementFromPoint(x, y);
          return Boolean(target?.closest('#intake-form') && (enter || target?.closest('button[type="submit"]')));
        }, { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, enter: call.name === 'press_key' && a.key === 'Enter' })) diagnostic('submission', 'STARTED');
        if (call.name === 'click') await page.mouse.click(x, y);
        if (call.name === 'double_click') await page.mouse.dblclick(x, y);
        if (['type', 'hotkey'].includes(call.name)) {
          // Read-only focus check; never select fields or supply data by DOM.
          if (!await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName))) throw new HandoffError('Text entry requires a focused form field.');
          if (call.name === 'type') { await page.keyboard.insertText(a.text); if (a.press_enter) await page.keyboard.press('Enter'); }
          else await page.keyboard.press('Control+A');
        }
        if (call.name === 'press_key') await page.keyboard.press(a.key);
        if (call.name === 'scroll') {
          await page.mouse.move(x, y);
          const distance = a.magnitude_in_pixels ?? 300;
          await page.mouse.wheel(a.direction === 'left' ? -distance : a.direction === 'right' ? distance : 0, a.direction === 'up' ? -distance : a.direction === 'down' ? distance : 0);
        }
        if (call.name === 'wait') await delay((a.seconds ?? 1) * 1000, undefined, { signal });
        if (call.name === 'navigate') {
          diagnostic('portal_navigation', 'STARTED');
          await page.goto(portalUrl);
          diagnostic('portal_navigation', 'SUCCEEDED');
        }
        diagnostic('verify_action', 'STARTED', { actionExecuted: true });
        check();
        diagnostic('verify_action', 'SUCCEEDED', { verificationSucceeded: true });
        return { receiptVisible: await page.locator('#receipt').isVisible() };
      },
      async receipt(expected) {
        check();
        if (!await page.locator('#receipt').isVisible() || await page.locator('#receipt h2').innerText() !== 'INTAKE RECEIVED') return null;
        const caseId = await page.locator('#case-id').innerText();
        if (!/^DEMO-[A-F0-9]{8}$/.test(caseId)) return null;
        // Verify the rendered receipt against the task; these reads never fill
        // the form or get sent to the model in place of screenshots.
        const entries = await page.locator('#received-fields').evaluate(dl => [...dl.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
        if (JSON.stringify(Object.fromEntries(entries)) !== JSON.stringify(expected)) throw tagAgentError(new HandoffError('Portal receipt does not match the reported case. Review and retry.'), 'PORTAL_STATE_MISMATCH');
        return caseId;
      },
    };
  } catch (error) { await close(); throw error; }
}
