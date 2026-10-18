import { test, expect } from '@playwright/test';

test.describe('SmartCareOps User Manual', () => {
  test('offers a responsive video pitch without autoplay or eager downloads', async ({ page }) => {
    await page.goto('/manual#overview');
    const pitch = page.locator('[data-manual-pitch]');
    const player = pitch.locator('video');
    const url = 'https://storage.googleapis.com/gen-lang-client-0710663107-smartcareops-public-media/smartcareops-video.mp4';
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('controls', '');
    await expect(player).toHaveAttribute('playsinline', '');
    await expect(player).toHaveAttribute('preload', 'none');
    await expect(player).not.toHaveAttribute('autoplay');
    await expect(player.locator('source')).toHaveAttribute('src', url);
    await expect(pitch.getByRole('link', { name: 'Open the video pitch' })).toHaveAttribute('href', url);
    expect(await player.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    await pitch.screenshot({ path: `tmp/manual-pitch-${test.info().project.name}.png` });
  });
  test('lists every public fictional demo account and its access boundary', async ({ page }) => {
    await page.goto('/manual#demo');
    const accounts = page.locator('[data-manual-demo-accounts]'), table = accounts.getByRole('table');
    await expect(page.locator('#overview').locator('[data-manual-demo-accounts]')).toBeVisible();
    for (const username of ['patient1', 'patient2', 'patient3', 'doctor1', 'doctor2', 'doctor3', 'dispatcher1', 'dispatcher2', 'commandcenter1', 'commandcenter2', 'admin1']) await expect(table.getByText(username, { exact: true })).toBeVisible();
    for (const fullName of ['John Doe', 'Ericka Smith', 'Donna Lim', 'Marie Carter', 'Alex Parks', 'Bryan Lee', 'Elmer Vance', 'Clara Ashford', 'Maya Linley', 'Aster Dray', 'Gemini Master']) await expect(table.getByText(fullName, { exact: true })).toBeVisible();
    await expect(accounts).toContainText('Admin; no purge access');
    await expect(accounts).toContainText('Only configured Google administrator accounts can purge test data.');
  });
  test('presents the complete guide and portal links on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manual');
    await expect(page.getByRole('heading', { name: 'A clear path through connected care.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Using SmartCareOps as a Patient' })).toBeVisible();
    await expect(page.locator('#patient')).toContainText('Multilingual voice intake');
    await expect(page.locator('#patient')).toContainText('unless you explicitly ask to change it');
    await expect(page.locator('#patient')).toContainText('Please speak in Tagalog.');
    await expect(page.locator('#patient')).toContainText('Voice startup delays');
    await expect(page.locator('#patient')).toContainText('Keeping one Live service instance warm resolved the cold-start problem');
    await expect(page.locator('#patient')).toContainText('clarify or repeat yourself');
    await expect(page.locator('#patient')).toContainText('Typed chat intake');
    await expect(page.locator('#patient')).toContainText('does not use the microphone');
    await expect(page.locator('#patient')).toContainText('Refresh can restore an active chat');
    await expect(page.locator('#patient')).toContainText('share one pain-location image');
    await expect(page.locator('#patient')).toContainText('does not contact a dispatcher, emergency service, or hospital');
    const multimodal = page.locator('[data-manual-multimodal]');
    await expect(multimodal).toHaveCount(1);
    await expect(multimodal.getByText('Multimodal intake', { exact: true })).toBeVisible();
    await expect(multimodal).toContainText('Voice intake also supports showing a clearly labeled medication package');
    await expect(multimodal).toContainText('An image or pointing gesture does not diagnose an injury');
    await expect(page.getByText('Multimodal intake', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'See the bigger picture' })).toBeVisible();
    await expect(page.locator('#patient').getByRole('link', { name: 'Open Patient Portal', exact: true })).toBeVisible();
    await expect(page.locator('#doctor').getByRole('link', { name: 'Open Doctor Portal', exact: true })).toBeVisible();
    await expect(page.locator('#command-center').getByRole('link', { name: 'Open Command Center', exact: true })).toBeVisible();
    await expect(page.locator('.manual-sidebar')).toBeVisible();
  });

  test('explains the bounded agentic workflow before the portal guides', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manual#how-it-works');

    const howItWorks = page.locator('#how-it-works');
    await expect(howItWorks.getByRole('heading', { name: 'How SmartCareOps works' })).toBeVisible();
    await expect(howItWorks.getByRole('heading', { name: 'What makes SmartCareOps agentic?' })).toBeVisible();
    await expect(page.locator('.manual-operator-loop')).toHaveCount(1);
    await expect(page.locator('#command-center .manual-operator-loop')).toHaveCount(0);
    await expect(howItWorks.locator('.manual-operator-loop span')).toHaveText([
      'Observe', 'Detect', 'Forecast', 'Compare', 'Approve', 'Monitor', 'Replan',
    ]);
    expect(await page.evaluate(() => Boolean(
      document.querySelector('#how-it-works').compareDocumentPosition(document.querySelector('#patient'))
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ))).toBe(true);

    const agentic = page.locator('[data-manual-agentic]');
    await expect(agentic).toContainText('bounded agents: software helpers with defined limits');
    await expect(agentic).toContainText('review only the evidence their role is allowed to use');
    await expect(agentic).toContainText('limited set of tools');
    await expect(agentic).toContainText('authorized person’s approval');
    await expect(agentic).toContainText('evidence and approval are still current');
    await expect(agentic).toContainText('Expired or superseded approvals cannot be used');
    await expect(agentic).toContainText('repeated requests do not create duplicate actions');
    await expect(agentic).toContainText('synthetic hospital-capacity pressure');
    await expect(agentic).toContainText('available simulated resource information');
    await expect(agentic).toContainText('permitted simulated outcome is recorded');
    await expect(agentic).toContainText('re-evaluate the options');
    await expect(agentic).toContainText('does not contact real hospitals');

    const boundaries = page.locator('[data-manual-ai-boundaries]');
    await expect(boundaries).toContainText('Gemini Live');
    await expect(boundaries).toContainText('real-time patient intake conversation');
    await expect(boundaries).toContainText('Forecasts, CareTwin comparisons, pattern detection, and simulation');
    await expect(boundaries).toContainText('deterministic or advisory capabilities');
    await expect(boundaries).toContainText('do not independently execute operations');
    await expect(howItWorks).toContainText('fictional or simulated');
    await expect(howItWorks).toContainText('do not imply unrestricted autonomy or real-world hospital contact');
  });

  test('explains the delivered medicine-package flow once with Patient and Doctor boundaries', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manual#patient');

    const patientGuide = page.locator('[data-manual-patient-medicine]');
    const doctorGuide = page.locator('[data-manual-doctor-medicine]');
    await expect(patientGuide).toHaveCount(1);
    await expect(doctorGuide).toHaveCount(1);
    await expect(page.locator('#patient [data-manual-patient-medicine]')).toHaveCount(1);
    await expect(page.locator('#doctor [data-manual-doctor-medicine]')).toHaveCount(1);
    await expect(patientGuide.getByRole('heading', { name: 'Showing a medicine package' })).toBeVisible();
    await expect(patientGuide).toContainText('During an active voice intake');
    await expect(patientGuide).toContainText('Use camera');
    await expect(patientGuide).toContainText('Upload photo');
    await expect(patientGuide).toContainText('Use this photo starts the reading automatically');
    await expect(patientGuide).toContainText('an uploaded chat photo requires');
    await expect(patientGuide).toContainText('Medicine package');
    await expect(patientGuide).toContainText('Use this photo');
    await expect(patientGuide).toContainText('Retake photo');
    await expect(patientGuide).toContainText('only a clearly visible medicine name and strength');
    await expect(patientGuide).toContainText('describe in your own words how you actually take the medicine');
    await expect(patientGuide).toContainText('Save confirmed medicine');
    await expect(patientGuide).toContainText('Checking the box alone does not save the entry');
    await expect(patientGuide).toContainText('Wait for the saved confirmation');
    await expect(patientGuide).toContainText('continue the intake by voice');
    await expect(patientGuide).toContainText('Package directions do not establish how you actually use a medicine');
    await expect(patientGuide).toContainText('does not identify loose pills');
    await expect(patientGuide).toContainText('guess unclear details');
    await expect(patientGuide).toContainText('provide medication advice');
    await expect(patientGuide).toContainText('recommend dose changes');

    await doctorGuide.scrollIntoViewIfNeeded();
    await expect(doctorGuide.getByRole('heading', { name: 'Medicines shown during intake' })).toBeVisible();
    await expect(doctorGuide).toContainText("case's Patient report/evidence area");
    await expect(doctorGuide).toContainText('patient-reported medicine name, strength');
    await expect(doctorGuide).toContainText("Patient's own description of how they take it");
    await expect(doctorGuide).toContainText('Patient-reported; packaging shown');
    await expect(doctorGuide).toContainText('Not clinically verified');
    await expect(doctorGuide).toContainText('separate from AI analysis');
    await expect(doctorGuide).toContainText('without assuming that a captured package image is available');

    await expect(page.getByRole('heading', { name: 'Showing a medicine package' })).toHaveCount(1);
    await expect(page.getByText('Checking the box alone does not save the entry', { exact: false })).toHaveCount(1);
    await expect(page.locator('[data-manual-multimodal]')).toHaveCount(1);
  });

  test('labels the responsive Command Center concept illustration accurately', async ({ page }) => {
    for (const width of [1440, 412, 360]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 915 });
      await page.goto('/manual#command-center');

      const figure = page.locator('[data-manual-command-concept]');
      const image = figure.getByRole('img');
      await figure.scrollIntoViewIfNeeded();
      await expect(figure).toBeVisible();
      await expect(image).toHaveAttribute('alt', 'Fictional aerial hospital concept with ambulance movements and a Command Center overlay showing illustrative capacity, demand, and alert indicators.');
      await expect(image).toHaveAttribute('loading', 'lazy');
      await expect(figure.locator('figcaption')).toContainText('Fictional concept illustration');
      await expect(figure.locator('figcaption')).toContainText('not an actual SmartCareOps screen or live hospital feed');
      await expect(figure.locator('figcaption')).toContainText('hospital, dashboard, statuses, percentages, timestamps, and ambulance details shown are illustrative');
      await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);

      const bounds = await figure.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const renderedImage = element.querySelector('img').getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewport: window.innerWidth,
          imageWidth: renderedImage.width,
          figureWidth: rect.width,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
      expect(bounds.imageWidth).toBeLessThanOrEqual(bounds.figureWidth + 1);
      expect(bounds.overflow).toBe(false);
    }
  });

  test('documents the one-click Hospital Operations demo and its review actions', async ({ page }) => {
    await page.goto('/manual#command-center');
    const guide = page.locator('[data-manual-hospital-demo]');
    await expect(guide.getByRole('heading', { name: 'One-click hospital pressure demo' })).toBeVisible();
    await expect(guide).toContainText('Run demo');
    await expect(guide).toContainText('What the demo did');
    await expect(guide).toContainText('CONSTRAINED');
    await expect(guide).toContainText('Capacity response simulation');
    await expect(guide).toContainText('Staffing response simulation');
    await expect(page.locator('#command-center')).toContainText('No reset, capacity, or assessment button is needed');
    await expect(page.locator('#command-center')).not.toContainText('Advance 5 min moves synthetic network time forward');
  });

  test('documents role-aware notification behavior and respiratory-cluster boundaries', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/manual#notifications');

    const guides = page.locator('[data-manual-notifications]');
    await expect(guides).toHaveCount(1);
    await expect(page.locator('#doctor [data-manual-notifications]')).toHaveCount(0);
    await expect(page.locator('#dispatcher [data-manual-notifications]')).toHaveCount(0);
    await expect(page.locator('#command-center [data-manual-notifications]')).toHaveCount(0);

    const guide = guides.first();
    await expect(page.getByRole('heading', { name: 'Notifications across Patient and staff portals' })).toBeVisible();
    await expect(guide).toContainText('Doctor Portal, Dispatcher Portal, and Command Center');
    await expect(guide).toContainText('Dismissing a popup does not remove its history entry');
    await expect(guide).toContainText('Action required');
    await expect(guide).toContainText('notification service is unavailable');
    await expect(guide).toContainText('severity change updates that same notice');
    await expect(guide).toContainText('marks it cleared while preserving its history');
    await expect(guide).toContainText('Doctors cannot acknowledge the alert');
    await expect(guide).toContainText('does not trigger routing, ambulance assignment, or dispatch');
    await expect(guide).toContainText('Operators review and acknowledge the alert through Pattern Intelligence');
    await expect(guide).toContainText('fictional, in-app notices');
    await expect(guide).toContainText('external message was sent');
  });

  test('keeps visible guidance free of milestone and configuration language', async ({ page }) => {
    await page.goto('/manual#technology');
    const visibleCopy = await page.locator('.manual-page').innerText();

    expect(visibleCopy).not.toMatch(/\bM\d+\b/);
    expect(visibleCopy).not.toContain('GEMINI_LIVE_MODEL');
    expect(visibleCopy).not.toContain('GEMINI_CLINICAL_MODEL');
    expect(visibleCopy).not.toMatch(/\bbackend\b/i);
    expect(visibleCopy).not.toContain('server-side');
    expect(visibleCopy).not.toContain('chain-of-thought');
    await expect(page.locator('#technology')).toContainText('Separate AI roles');
    await expect(page.locator('#technology').getByRole('link', { name: 'Open Technology' })).toHaveAttribute('href', '/technology');
    await expect(page.locator('#technology')).toContainText('authorized Doctor remains responsible');
    await expect(page.locator('#technology')).toContainText('gemini-3.8-live');
    await expect(page.locator('#technology')).toContainText('gemini-3.6-flash');
    await expect(page.locator('#technology')).toContainText('gemini-3.8-flash');
    await expect(page.locator('#technology')).toContainText('Gemini Enterprise Agent Platform');
    await expect(page.locator('#technology')).toContainText('named fictional demo cases');
    await expect(page.locator('#technology')).toContainText('Doctor Portal identifies the assessment source');
    await expect(page.locator('#technology')).toContainText('existing clinical model is the automatic fallback');
    await expect(page.locator('#technology')).toContainText('Model Armor inspected policy admission and remains inspect-only');
    await expect(page.locator('#security')).toContainText('Regional deployment');
    await expect(page.locator('#security')).toContainText('verified data-residency requirement');
    await expect(page.locator('#security')).toContainText('supported regional endpoints and location policies');
  });

  test('keeps the patient guide usable on mobile', async ({ page }) => {
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await page.goto('/manual#patient');
      await expect(page.getByRole('heading', { name: 'Using SmartCareOps as a Patient' })).toBeVisible();
      await expect(page.locator('.manual-mobile-picker')).toBeVisible();
      await expect(page.locator('.manual-page')).toHaveCSS('overflow-x', 'visible');
      await expect(page.locator('.site-header .smartcareops-brand-mark i')).toHaveCount(2);
      const multimodal = page.locator('[data-manual-multimodal]');
      await multimodal.scrollIntoViewIfNeeded();
      await expect(multimodal).toBeVisible();
      const medicineGuide = page.locator('[data-manual-patient-medicine]');
      await medicineGuide.scrollIntoViewIfNeeded();
      await expect(medicineGuide).toBeVisible();
      const widths = await page.evaluate(() => ({
        grid: document.querySelector('.manual-hero-grid').getBoundingClientRect().width,
        copy: document.querySelector('.manual-hero-grid > div:first-child').getBoundingClientRect().width,
        multimodal: document.querySelector('[data-manual-multimodal]').getBoundingClientRect().width,
        medicine: document.querySelector('[data-manual-patient-medicine]').getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      expect(widths.copy).toBeGreaterThanOrEqual(widths.grid - 1);
      expect(widths.multimodal).toBeLessThanOrEqual(width + 1);
      expect(widths.medicine).toBeLessThanOrEqual(width + 1);
      expect(widths.overflow).toBeFalsy();
    }
  });

  test('keeps Doctor medicine guidance readable on mobile', async ({ page }) => {
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await page.goto('/manual#doctor');
      const guide = page.locator('[data-manual-doctor-medicine]');
      await guide.scrollIntoViewIfNeeded();
      await expect(guide).toBeVisible();
      const bounds = await guide.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: window.innerWidth };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  test('documents the Doctor IDP workflow and verification boundary', async ({ page }) => {
    await page.goto('/manual#doctor');
    const guide = page.locator('[data-manual-doctor-idp]');
    await expect(guide).toHaveCount(1);
    await expect(guide.getByRole('heading', { name: 'Intelligent Data Processing (IDP) for laboratory reports' })).toBeVisible();
    await expect(guide).toContainText('Model used: gemini-3.6-flash');
    await expect(guide).toContainText('Extract with Gemini');
    await expect(guide).toContainText('marked as unverified');
    await expect(guide).toContainText('Compare every included value with the original report');
    await expect(guide).toContainText('Verify reviewed results');
    await expect(guide).toContainText('uploading or extracting alone does not verify the report');
    await expect(guide).toContainText('Request assessment of verified results');
    await expect(guide).toContainText('review-only');
    await expect(guide).toContainText('Doctor remains responsible');
  });

  test('keeps notification guidance readable without mobile overflow', async ({ page }) => {
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await page.goto('/manual#notifications');
      const guide = page.locator('[data-manual-notifications]');
      await guide.scrollIntoViewIfNeeded();
      await expect(guide).toBeVisible();
      const bounds = await guide.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: window.innerWidth };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  test('keeps the agentic explanation readable without mobile overflow', async ({ page }) => {
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await page.goto('/manual#how-it-works');
      const section = page.locator('#how-it-works');
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByRole('heading', { name: 'What makes SmartCareOps agentic?' })).toBeVisible();
      const bounds = await section.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: window.innerWidth };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });


  test('guides mode selection, separate care paths and evidence sharing without promising hospital care', async ({ page }) => {
    await page.goto('/manual');
    const patient = page.locator('#patient');
    await expect(patient).toContainText('Choosing a mode does not start intake or give consent');
    await expect(patient).toContainText('Use microphone or Type in chat');
    await expect(patient).toContainText('Shift+Enter adds a new line');
    await expect(patient).toContainText('Cancel chat');
    await expect(patient).toContainText('saved emergency case appears in the authorized Dispatcher queue');
    const overview = page.locator('#overview');
    await expect(overview).toContainText('AI-native healthcare intake and coordination platform');
    const purpose = overview.locator('[data-manual-platform-purpose]');
    await expect(purpose).toContainText('Patient care:');
    await expect(purpose).toContainText('Response coordination:');
    await expect(purpose).toContainText('Network intelligence:');
    await expect(purpose).toContainText('preserved Patient evidence, explicit human authority, recorded outcomes');
    await expect(purpose).toContainText('simulated comparisons of response options before action');
    await expect(purpose).toContainText('not a claim that no other healthcare solution offers similar features');
    await expect(purpose).toContainText('fictional or simulated');
    const paths = page.locator('[data-manual-care-paths]');
    await expect(paths).toContainText('An appointment is optional');
    await expect(paths).toContainText('Normal Doctor routing is skipped');
    await expect(page.locator('.manual-hero-card')).not.toContainText('Patient → Doctor → Dispatcher');
    await expect(page.locator('#care-journey .manual-journey-list article')).toHaveCount(6);
    await expect(page.locator('#care-journey')).toContainText('inactive milestones are not a promise');
    const evidence = page.locator('[data-manual-pain-evidence]');
    await expect(evidence).toContainText('description is optional in voice intake');
    await expect(evidence).toContainText('required for chat');
    await expect(evidence).toContainText('Retry sharing image');
    await expect(evidence).toContainText('Saved images are private');
  });

  test('documents current staff actions, appointment notices and Admin safeguards with responsive navigation', async ({ page }) => {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 915 });
      await page.goto('/manual#admin');
      const admin = page.locator('#admin');
      await expect(admin.getByRole('heading', { name: 'Manage access and fictional test data' })).toBeVisible();
      await expect(admin).not.toContainText('Preview data to purge');
      await expect(admin).not.toContainText('PURGE ALL TEST DATA');
      await expect(admin).not.toContainText('johnlouisgarcia@gmail.com');
      await expect(admin).not.toContainText('chebulay.12@gmail.com');
      await expect(admin).not.toContainText('Google sign-in test accounts');
      await expect(admin.getByRole('heading', { name: 'Purge test data', exact: true })).toHaveCount(0);
      await expect(admin).toContainText('Applications and verified specialties');
      await expect(admin).toContainText('Approved patients only');
      await admin.screenshot({ path: `tmp/manual-admin-${test.info().project.name}-${width}.png` });
      const nav = page.locator(width === 1440 ? '.manual-sidebar' : '.manual-mobile-picker');
      await expect(nav.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
      await expect(admin.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '#demo');
      await expect(page.locator('#demo').getByRole('link', { name: 'Next: Admin' })).toHaveAttribute('href', '#admin');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await expect(page.locator('[data-manual-doctor-controls]')).toContainText('Submit for Admin review');
    await expect(page.locator('[data-manual-doctor-controls]')).toContainText('Append observation');
    await expect(page.locator('#doctor')).toContainText('Send proposal to Patient');
    await expect(page.locator('[data-manual-dispatch-actions]')).toContainText('newest first');
    await expect(page.locator('[data-manual-dispatch-actions]')).toContainText('Complete simulated response');
    await expect(page.locator('[data-manual-response-activity]')).toContainText('Refresh response activity');
    await expect(page.locator('[data-manual-notifications]')).toContainText('Patients receive fictional proposals');
    const demoConsole = page.locator('[data-manual-demo-console]');
    await expect(demoConsole).toContainText('Hospital Operations activation should read');
    await expect(demoConsole).toContainText('Recent agentic sessions');
    await expect(demoConsole.getByRole('link', { name: 'Open Demo Console' })).toHaveAttribute('href', '/demo-console');
  });

  test('preserves all guide content with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/manual');
    await expect(page.getByRole('heading', { name: 'Designed for clear responsibility' })).toBeVisible();
    await expect(page.getByText('AI supports action. People approve it.')).toBeVisible();
    await expect(page.locator('[data-manual-agentic]')).toContainText('What makes SmartCareOps agentic?');
    await expect(page.locator('[data-manual-ai-boundaries]')).toContainText('do not independently execute operations');
    await expect(page.locator('[data-manual-notifications]')).toContainText('possible synthetic respiratory cluster');
    await expect(page.locator('[data-manual-multimodal]')).toContainText('packaging is not treated as proof');
    await expect(page.locator('[data-manual-patient-medicine]')).toContainText('Save confirmed medicine');
    await expect(page.locator('[data-manual-doctor-medicine]')).toContainText('Not clinically verified');
    await expect(page.getByRole('heading', { name: 'See SmartCareOps end to end' })).toBeVisible();
  });
});
