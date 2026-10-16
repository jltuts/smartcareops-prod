import { test, expect } from '@playwright/test';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('authenticated session bootstrap sends the chosen language before creating its WebSocket', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const events = [];
    class Socket { constructor(url, protocols) { events.push({ type: 'socket', url: String(url), protocols }); } }
    const fetchSession = async (path, options) => {
      events.push({ type: 'bootstrap', path, options });
      return { ok: true, json: async () => ({ token: 'A'.repeat(43), intakeSessionId: 'a'.repeat(64), preferredLanguage: 'fil', expiresAt: new Date(Date.now() + 60_000).toISOString(), webSocketUrl: 'wss://live.example.invalid/api/live' }) };
    };
    await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location, preferredLanguage: 'fil' });
    return events;
  });
  expect(result.map(event => event.type)).toEqual(['bootstrap', 'socket']);
  expect(result[0].path).toBe('/api/live/session');
  expect(JSON.parse(result[0].options.body)).toEqual({ preferredLanguage: 'fil' });
  expect(result[1].url).toBe('wss://live.example.invalid/api/live');
});

test('Patient language selector defaults to English and its help works by keyboard and touch', async ({ page, isMobile }) => {
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]:visible').first().click();
  const selector = page.getByLabel('Preferred conversation language');
  await expect(selector).toHaveValue('en');
  await expect(selector.locator('option')).toHaveCount(99);
  await expect(selector.locator('option[value="fil"]')).toHaveText('Filipino / Tagalog');
  const help = page.locator('.conversation-language-help');
  const helpButton = help.getByRole('button', { name: 'About conversation language' });
  await helpButton.hover();
  await expect(help.getByRole('tooltip')).toBeVisible();
  await page.locator('#conversation-heading').hover();
  await expect(help.getByRole('tooltip')).toBeHidden();
  await helpButton.focus();
  await expect(help.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(help.getByRole('tooltip')).toHaveText('Choose the language you’d like to speak. To change language during the conversation, say, for example, “Please speak in Tagalog.”');
  await helpButton.press('Enter');
  await selector.focus();
  await expect(help.getByRole('tooltip')).toBeHidden();
  if (isMobile) {
    const bounds = await helpButton.boundingBox();
    await page.touchscreen.tap(bounds.x + 17, bounds.y + 17);
    await expect(help.getByRole('tooltip')).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('preferred language is sent before Live starts, consent stays required, and the audio session can end normally', async ({ page }) => {
  const starts = [];
  let relay;
  await page.routeWebSocket('**/api/live', socket => socket.onMessage(raw => {
    relay = socket;
    const message = JSON.parse(raw.toString());
    if (message.type === 'start') {
      starts.push(message);
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send(JSON.stringify({ type: 'transcript', role: 'Gemini', text: 'Kumusta. Ano ang pangalan mo?', finished: true }));
    }
  }));
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]:visible').first().click();
  const selector = page.getByLabel('Preferred conversation language');
  await selector.selectOption('fil');
  const start = page.getByRole('button', { name: 'Start Conversation' });
  await expect(start).toBeDisabled();
  expect(starts).toHaveLength(0);
  await page.locator('#intake-fictional').check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect(page.locator('#transcript')).toContainText('Kumusta. Ano ang pangalan mo?');
  await expect(selector).toBeDisabled();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0].preferredLanguage).toBe('fil');

  // Mock transcript turns stand in for provider messages; they verify that language choice does not restart the socket.
  relay.send(JSON.stringify({ type: 'transcript', role: 'Patient', text: 'Não', finished: true }));
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect.poll(() => starts.length).toBe(1);
  await page.getByRole('button', { name: 'End Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Disconnected');
  await expect(selector).toBeEnabled();
  await expect(selector).toHaveValue('en');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
