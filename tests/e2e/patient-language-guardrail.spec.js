import { test, expect } from '@playwright/test';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

for (const language of ['en', 'fil', 'mr']) {
  test(`active Live setup carries the ${language} guardrail before the opening request`, async ({ page }) => {
    let setup, opening;
    await page.route('**/api/live/session', async route => {
      expect(route.request().postDataJSON().preferredLanguage).toBe(language);
      await route.fulfill({ json: { geminiToken: 'auth_tokens/guardrail-test', model: 'gemini-3.8-live', preferredLanguage: language, intakeSessionId: 'a'.repeat(64) } });
    });
    await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => ws.onMessage(raw => {
      const data = JSON.parse(raw);
      if (data.setup) { setup = data.setup; ws.send(JSON.stringify({ setupComplete: {} })); }
      if (data.realtimeInput?.text) { expect(setup).toBeTruthy(); opening = data.realtimeInput.text; }
    }));
    await page.goto('/patient');
    await page.locator('[data-intake-mode="voice"]').first().click();
    await page.locator('#conversation-language').selectOption(language);
    await page.locator('#intake-fictional').check();
    await page.locator('#start-conversation').click();
    const expectedOpening = language === 'fil'
      ? 'Kamusta, ito ang SmartCareOps. Ano ang gusto mong itawag ko sa iyo?'
      : 'Hello, this is SmartCareOps. What would you like me to call you?';
    await expect.poll(() => opening).toBe(`Begin the intake now. Ask exactly: "${expectedOpening}"`);
    expect(setup.inputAudioTranscription).toEqual(language === 'fil'
      ? { languageCodes: ['fil-PH', 'en-US'] }
      : {});
    expect(setup.outputAudioTranscription).toEqual({});
    const systemPrompt = setup.systemInstruction.parts[0].text;
    expect(systemPrompt).toContain(`1. Ask exactly: "${expectedOpening}"`);
    if (language === 'fil') {
      expect(systemPrompt).toContain('2. Ask exactly: "Ano ang iyong ipinag-aalala?"');
      expect(systemPrompt).toContain('say: "Pasensya na, hindi ko naintindihan iyon."');
      expect(systemPrompt).toContain('3. Ask exactly: "Kailan ito nagsimula o huling nagbago?"');
      expect(systemPrompt).toContain('4. Ask exactly: "Gaano ito kalala mula 1 hanggang 10, kung saan ang 10 ang pinakamalala?"');
      expect(systemPrompt).toContain('5. Ask exactly: "Bagong sintomas ba ito, pabalik-balik, o may kaugnayan sa isang kondisyon na alam mo na?"');
      expect(systemPrompt).toContain('6. Ask exactly: "Nakuha ko na ang lahat ng impormasyong kailangan ko para sa intake na ito. Mayroon ka pa bang gustong sabihin?"');
      expect(systemPrompt).toContain('respond with exactly: "Salamat. Tapos na ang iyong intake."');
      expect(systemPrompt).toContain('Say exactly: "Binuksan ko ang mga kontrol para sa pakete ng gamot.');
      expect(systemPrompt).toContain('Say exactly: "Binuksan ko ang mga kontrol para sa lokasyon ng sakit.');
      expect(systemPrompt).not.toContain('Ask exactly: "Hello, this is SmartCareOps. What would you like me to call you?"');
      expect(systemPrompt).not.toContain('2. Ask exactly: "What is your concern?"');
      expect(systemPrompt).not.toContain('4. Ask exactly: "How severe is it from 1 to 10, with 10 being the most severe?"');
      expect(systemPrompt).not.toContain(`6. Ask exactly: "I got all the information I need for this intake. Is there anything else you want to say?"`);
      expect(systemPrompt).not.toContain('respond with exactly: "Thank you. Your intake is complete."');
    } else {
      expect(systemPrompt).toContain('say: "I\'m sorry, I didn\'t catch that."');
      expect(systemPrompt).toContain('3. Ask exactly: "When did it start or last change?"');
      expect(systemPrompt).toContain('4. Ask exactly: "How severe is it from 1 to 10, with 10 being the most severe?"');
      expect(systemPrompt).toContain('5. Ask exactly: "Is this new, recurring, or related to a condition you already know about?"');
      expect(systemPrompt).toContain('6. Ask exactly: "I got all the information I need for this intake. Is there anything else you want to say?"');
      expect(systemPrompt).toContain('respond with exactly: "Thank you. Your intake is complete."');
    }
    const prompt = JSON.stringify(setup);
    expect(prompt).toContain(`selected conversation language is ${language}`);
    expect(prompt).toContain('unless the patient explicitly asks to change it');
    expect(prompt).toContain('Names, accents, medical terms, isolated foreign words');
    expect(prompt).toContain('without restarting intake or discarding facts');
    expect(prompt).toContain('A language-change request alone is not an answer to the pending intake question');
    expect(prompt).toContain('repeat that same unanswered question in the requested language and wait');
    expect(prompt).toContain('Oo, Lui. Ano ang iyong ipinag-aalala?');
    expect(prompt).toContain('because no concern has been reported');
    expect(prompt).toContain('If the same turn also clearly answers the pending question, preserve that answer');
    expect(prompt).toContain('Emergency handling always retains priority');
    expect(prompt).toContain('briefly ask which language the patient prefers before switching');
    expect(prompt).toContain('request clarification rather than guessing symptoms or intent');
    expect(prompt).toContain('Preserve all existing exact-wording instructions');
    expect(prompt).toContain('trigger_emergency');
    expect(prompt).toContain('complete_intake');
    await page.locator('#end-conversation').click();
    await expect(page.locator('#connection-status')).toHaveText('Disconnected');
    // Mocked provider verifies configuration and lifecycle, not real spoken adherence.
  });
}
