import { test, expect } from '@playwright/test';

const portalLinks = [
  ['/patient', 'Welcome to your care.'], ['/doctor', 'SmartCareOps / Doctor workspace · Fictional demo'],
  ['/dispatcher', 'Dispatcher Portal'], ['/command-center', 'Command Center'],
];

test('landing page tells the complete SmartCareOps story at 1440p', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'SmartCareOps', exact: true })).toBeVisible();
  await expect(page.getByText('From first contact', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('AI that doesn’t just assess.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore SmartCareOps/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See how it works' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  const hero = await page.locator('.landing-hero').boundingBox();
  expect(hero.width).toBeGreaterThanOrEqual(1400);
  expect(hero.height).toBeGreaterThanOrEqual(850);
  for (const [id, heading] of [['portals', 'Choose your workspace.'], ['intelligence', 'From facts to coordinated action'], ['about', 'Better care starts with']]) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: new RegExp(heading) })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.locator('body')).not.toContainText(/M15|M16|M17|M18|HANDOFF|Codex|ChatGPT/i);
});

test('landing composition remains cinematic on a 1920px display', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  const copy = await page.locator('.landing-hero-copy').boundingBox();
  const visual = await page.locator('.landing-hero-visual').boundingBox();
  expect(copy.x).toBeLessThan(visual.x);
  expect(visual.width).toBeGreaterThan(600);
  expect(visual.height).toBeGreaterThan(600);
  await expect(page.locator('.landing-portal-card')).toHaveCount(4);
  const portalTops = await page.locator('.landing-portal-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)));
  expect(new Set(portalTops).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('desktop hero headline keeps a safe geometric gap from the visual', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const geometry = await page.evaluate(() => {
      const headline = document.querySelector('.landing-hero h1').getBoundingClientRect();
      const visual = document.querySelector('.landing-hero-visual').getBoundingClientRect();
      const lines = [...document.querySelectorAll('.landing-hero-line')];
      return {
        headlineRight: headline.right,
        visualLeft: visual.left,
        lineOverflow: lines.some(line => line.scrollWidth > line.clientWidth + 1),
      };
    });
    expect(geometry.headlineRight + 32).toBeLessThanOrEqual(geometry.visualLeft);
    expect(geometry.lineOverflow).toBeFalsy();
  }
});

test('mobile landing keeps the full narrative without pinned or overflowing content', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'SmartCareOps', exact: true })).toBeVisible();
  await expect(page.locator('.landing-nav-links')).toBeHidden();
  await expect(page.locator('.landing-portal-card')).toHaveCount(4);
  await page.locator('#portals').scrollIntoViewIfNeeded();
  await expect(page.locator('.landing-portal-card[href="/patient"]')).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore SmartCareOps/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See how it works' })).toBeVisible();
  await page.locator('#intelligence').scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: /From facts to coordinated action/ })).toBeVisible();
  await page.locator('#about').scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: /Better care starts with/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('hero primary action reaches the unchanged How It Works section', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.goto('/');
  const action = page.getByRole('link', { name: 'See how it works' });
  await expect(action).toHaveClass(/landing-button-primary/);
  await action.click();
  await expect(page).toHaveURL(/#intelligence$/);
  await expect(page.getByRole('heading', { name: /From facts to coordinated action/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'User Manual' })).toHaveAttribute('href', '/manual');
});

test('mobile hero action reveals How It Works below the fixed header repeatedly and preserves Back', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await page.goto('/');
  const action = page.getByRole('link', { name: 'See how it works' });
  const heading = page.getByText('From facts to coordinated action.', { exact: true });
  await action.click();
  await expect(page).toHaveURL(/\/#intelligence$/);
  await expect(heading).toBeInViewport();
  const headerBottom = await page.locator('.landing-nav').evaluate(element => element.getBoundingClientRect().bottom);
  expect((await heading.boundingBox()).y).toBeGreaterThanOrEqual(headerBottom - 4);
  await page.evaluate(() => window.scrollTo(0, 0));
  await action.click();
  await expect(heading).toBeInViewport();
  await expect(page.locator('.landing-hero')).not.toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.landing-hero')).toBeInViewport();
});

test('desktop hero action scrolls to How It Works without remounting Home', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.goto('/');
  const home = page.locator('.landing-page');
  await page.getByRole('link', { name: 'See how it works' }).click();
  await expect(page.getByText('From facts to coordinated action.', { exact: true })).toBeInViewport();
  await expect(page).toHaveURL(/\/#intelligence$/);
  await expect(home).toBeVisible();
  await page.goBack();
  await expect(page.locator('.landing-hero')).toBeInViewport();
});

test('landing navigation and progressive journey respond to scrolling', async ({ page }) => {
  test.skip(page.viewportSize().width < 900);
  await page.goto('/');
  await page.getByRole('link', { name: 'Portals', exact: true }).click();
  await expect(page).toHaveURL(/#portals$/);
  await expect(page.getByRole('heading', { name: 'Choose your workspace.' })).toBeInViewport();
  await page.getByRole('link', { name: 'How It Works', exact: true }).click();
  await expect(page).toHaveURL(/#intelligence$/);
  await expect(page.getByText('How SmartCareOps Works', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'User Manual' })).toHaveAttribute('href', '/manual');
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('.landing-nav')).not.toHaveClass(/is-scrolled/);
  await page.evaluate(() => scrollTo(0, 300));
  await expect(page.locator('.landing-nav')).toHaveClass(/is-scrolled/);
});

test('How It Works distinguishes normal care, emergency response, and network operations', async ({ page }) => {
  await page.goto('/howitworks');
  const section = page.locator('#intelligence');
  await expect(section).toContainText('voice or chat intake');
  await expect(section).toContainText('Doctor review.');
  await expect(section).toContainText('Dispatcher pathway.');
  await expect(section).toContainText('Capacity assessment.');
  await expect(section).toContainText('Routine intake alone does not activate it.');
});

test('About always opens the canonical About page from Home and Portals', async ({ page }) => {
  for (const path of ['/', '/#portals']) {
    await page.goto(path);
    const about = page.locator('.landing-nav-links a', { hasText: 'About' });
    await expect(about).toHaveAttribute('href', '/about');
    await about.evaluate(link => link.click());
    await expect(page).toHaveURL('/about');
    await expect(page.getByRole('heading', { level: 1, name: 'A clearer path through care.' })).toBeVisible();
  }
});

test('all four portal entry points retain their existing routes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  for (const [path, heading] of portalLinks) {
    await page.goto('/');
    await page.locator(`.landing-portal-card[href="${path}"]`).scrollIntoViewIfNeeded();
    await page.locator(`.landing-portal-card[href="${path}"]`).click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/landing-active/);
  }
});

test('portal selector explains every role with consistent actions and approved-access guidance', async ({ page }) => {
  await page.goto('/#portals');
  const section = page.locator('#portals');
  await expect(section.getByText('Four roles. One connected system.')).toBeVisible();
  await expect(section.getByText('Each workspace supports a different part of the care journey.')).toBeVisible();
  await expect(section.getByText('Access depends on your approved role.')).toBeVisible();
  const expected = [
    ['/patient', 'Patient', 'Start and follow your care.', 'Enter Patient Portal'],
    ['/doctor', 'Doctor', 'Review and decide.', 'Enter Doctor Portal'],
    ['/dispatcher', 'Dispatcher', 'Coordinate emergency response.', 'Enter Dispatcher Portal'],
    ['/command-center', 'Command Center', 'See the wider system.', 'Enter Command Center Portal'],
  ];
  for (const [path, role, title, action] of expected) {
    const card = section.locator(`.landing-portal-card[href="${path}"]`);
    await expect(card).toContainText(role);
    await expect(card.getByRole('heading', { name: title })).toBeVisible();
    await expect(card).toContainText(action);
    await expect(card.locator('.landing-portal-icon')).toHaveCount(1);
  }
  await expect(section.locator('.landing-portal-preview')).toHaveCount(0);
  const geometry = await section.locator('.landing-portal-card').evaluateAll(cards => cards.map(card => {
    const box = card.getBoundingClientRect();
    const action = card.querySelector('.landing-portal-link').getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), actionHeight: Math.round(action.height) };
  }));
  expect(geometry.every(card => card.actionHeight >= 44)).toBeTruthy();
  if (page.viewportSize().width >= 1200) {
    expect(new Set(geometry.map(card => card.y)).size).toBe(1);
    expect(Math.max(...geometry.map(card => card.height)) - Math.min(...geometry.map(card => card.height))).toBeLessThanOrEqual(2);
  } else {
    expect(new Set(geometry.map(card => card.x)).size).toBe(1);
    expect(geometry.every(card => card.width <= page.viewportSize().width)).toBeTruthy();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('reduced motion preserves every section and removes heavy transforms', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.landing-hero-visual')).toHaveCSS('transform', 'none');
  for (const selector of ['.landing-portal-card', '.landing-journey-step', '.landing-intelligence-stack article', '.landing-loop-stage']) {
    await expect(page.locator(selector).first()).toBeVisible();
  }
  await expect(page.locator('.landing-journey-step').first()).toHaveCSS('opacity', '1');
});

test('How It Works uses the supported six-step, safety-bounded workflow', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'See how it works' }).click();
  await expect(page.getByText('From facts to coordinated action.', { exact: true })).toBeVisible();
  await expect(page.getByText('SmartCareOps turns a patient conversation into a coordinated care response that remains subject to human review and approval.')).toBeVisible();
  await expect(page.locator('.landing-journey-step')).toHaveCount(6);
  for (const title of ['First contact', 'Understand', 'Reason', 'Coordinate', 'Human decision', 'Respond and monitor']) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('.landing-intelligence')).not.toContainText(/diagnos|chooses treatment|automatically dispatch/i);
});

test('mobile How It Works shows the first workflow cards below the fixed header', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await page.goto('/');
  await page.getByRole('link', { name: 'See how it works' }).click();
  const headerBottom = await page.locator('.landing-nav').evaluate(element => element.getBoundingClientRect().bottom);
  const first = page.locator('.landing-journey-step').first();
  const second = page.locator('.landing-journey-step').nth(1);
  await expect(first).toBeInViewport();
  expect((await first.boundingBox()).y).toBeGreaterThanOrEqual(headerBottom - 4);
  const viewport = page.viewportSize();
  const secondBox = await second.boundingBox();
  expect(secondBox.y).toBeLessThan(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
