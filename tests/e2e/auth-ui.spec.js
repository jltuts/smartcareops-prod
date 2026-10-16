import { test, expect } from '@playwright/test';

async function mountAuthHarness(page, initial) {
  await page.goto('/');
  await page.evaluate(async state => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    let current = state;
    let listener;
    const root = document.createElement('section');
    root.id = 'auth-boundary-test';
    document.body.prepend(root);
    mountAuthBar(root, {
      getState: () => current,
      subscribe: callback => { listener = callback; return () => {}; },
      signIn: () => {
        current = { status: 'SIGNED_IN', user: { displayName: 'Alex Patient', email: 'alex@example.invalid' }, authorizationStatus: 'READY',
          identity: { user: { roles: ['patient'] }, demoAccess: true, liveAvailable: true }, error: null };
        listener();
      },
      signOut: () => {
        current = { status: 'SIGNED_OUT', user: null, error: null };
        listener();
      },
    });
    window.setAuthHarnessState = next => { current = next; listener(); };
  }, initial);
  return page.locator('#auth-boundary-test');
}

test('auth loading does not flash the signed-out gate', async ({ page }) => {
  const root = await mountAuthHarness(page, { status: 'AUTH_LOADING', user: null, error: null });
  await expect(root.getByRole('status', { name: 'Restoring your session' })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await page.evaluate(() => window.setAuthHarnessState({ status: 'SIGNED_OUT', user: null, error: null }));
  await expect(root.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});

test('Google sign-in uses the official brand icon and preserves the existing sign-in action', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    const root = document.createElement('section'); root.id = 'google-brand-test'; document.body.prepend(root);
    window.__googleSignInCalls = 0;
    mountAuthBar(root, {
      getState: () => ({ status: 'SIGNED_OUT', user: null, error: null }),
      subscribe: () => () => {},
      signIn: () => { window.__googleSignInCalls += 1; },
      signOut: () => {},
    });
  });

  const root = page.locator('#google-brand-test');
  const signIn = root.getByRole('button', { name: 'Continue with Google' });
  const icon = signIn.locator('img.google-icon');
  await expect(signIn).toBeVisible();
  await expect(icon).toHaveAttribute('src', 'https://developers.google.com/static/identity/images/g-logo.png');
  await expect(icon).toHaveAttribute('alt', '');
  await expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer');
  await signIn.evaluate(button => button.click());
  await expect.poll(() => page.evaluate(() => window.__googleSignInCalls)).toBe(1);
  await expect(root.locator('input[type="password"]')).toHaveCount(0);
});

test('signed-out protected-route gate uses the same official Google brand asset', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderAccessBoundary } = await import('/src/app/router.js');
    renderAccessBoundary(document.querySelector('main'), '/doctor', {
      status: 'SIGNED_OUT', user: null, authorizationStatus: 'IDLE', identity: null,
    });
  });
  const signIn = page.locator('main').getByRole('button', { name: 'Continue with Google' });
  await expect(signIn.locator('img.google-icon')).toHaveAttribute('src', 'https://developers.google.com/static/identity/images/g-logo.png');
  await expect(signIn).toBeVisible();
});

test('staff account and workspace navigation wait until backend role resolution completes', async ({ page }) => {
  await page.goto('/doctor');
  await page.evaluate(() => {
    let current = { status: 'SIGNED_IN', user: { displayName: 'Alex Doctor', email: 'doctor@example.invalid' }, authorizationStatus: 'CHECKING', identity: null, error: null };
    let listener;
    const root = document.createElement('section'); root.id = 'auth-role-check-test'; document.body.prepend(root);
    const mountAuthBarPromise = import('/src/auth/ui.js').then(({ mountAuthBar }) => mountAuthBar(root, {
      getState: () => current,
      subscribe: callback => { listener = callback; callback(); return () => {}; },
      signIn: () => {}, signOut: () => {},
    }));
    window.__authRoleCheckUpdate = next => { current = next; listener?.(); };
    window.__authRoleCheckMount = mountAuthBarPromise;
  });
  await page.evaluate(() => window.__authRoleCheckMount);
  const root = page.locator('#auth-role-check-test');
  await expect(root.getByRole('status', { name: 'Checking portal access' })).toBeVisible();
  await expect(root.locator('a, button, nav, details')).toHaveCount(0);

  await page.waitForTimeout(120);
  await page.evaluate(() => window.__authRoleCheckUpdate({
    status: 'SIGNED_IN', user: { displayName: 'Alex Doctor', email: 'doctor@example.invalid' }, authorizationStatus: 'READY',
    identity: { user: { roles: ['doctor'], specialties: ['general_medicine'] }, demoAccess: false, liveAvailable: true }, error: null,
  }));
  await expect(root.locator('.portal-account-menu > summary')).toHaveText('My account');
  await root.locator('.portal-account-menu > summary').click();
  await expect(root.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(root.getByRole('navigation', { name: 'Switch workspace' })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('successful login updates identity immediately and sign-out restores signed-out UI', async ({ page }) => {
  const root = await mountAuthHarness(page, { status: 'SIGNED_OUT', user: null, error: null });
  await root.getByRole('button', { name: 'Continue with Google' }).evaluate(button => button.click());
  await expect(root).toContainText('Alex Patient');
  await expect(root).toContainText('alex@example.invalid');
  await root.locator('.portal-account-menu > summary').click();
  await expect(root.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(root).not.toContainText('Not signed in');
  await root.getByRole('button', { name: 'Sign out' }).evaluate(button => button.click());
  await expect(root.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});

test('restored observer state renders the signed-in identity after refresh', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('auth-test-restored', JSON.stringify({ displayName: 'Restored User', email: 'restored@example.invalid' })));
  await page.reload();
  await page.evaluate(async () => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    const user = JSON.parse(localStorage.getItem('auth-test-restored'));
    const root = document.createElement('section'); root.id = 'restored-auth-test'; document.body.prepend(root);
    mountAuthBar(root, { getState: () => ({ status: 'SIGNED_IN', user, authorizationStatus: 'READY', identity: { user: { ...user, roles: ['patient'] } }, error: null }), subscribe: () => () => {}, signIn: () => {}, signOut: () => {} });
  });
  await expect(page.locator('#restored-auth-test')).toContainText('Restored User');
  await page.locator('#restored-auth-test .portal-account-menu > summary').click();
  await expect(page.locator('#restored-auth-test').getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('staff portal headers expose a visible My account menu without placeholder avatars', async ({ page }) => {
  for (const path of ['/doctor', '/dispatcher', '/command-center']) {
    await page.goto(path);
    await page.evaluate(async () => {
      const { mountAuthBar } = await import('/src/auth/ui.js');
      const root = document.createElement('div');
      root.id = 'portal-account-test';
      document.querySelector('.site-header').append(root);
      mountAuthBar(root, {
        getState: () => ({ status: 'SIGNED_IN', user: { displayName: 'Alex Operator', email: 'operator@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['doctor', 'dispatcher', 'command_center'] } }, error: null }),
        subscribe: () => () => {}, signIn: () => {}, signOut: () => {},
      });
    });
    const account = page.locator('#portal-account-test');
    const summary = account.locator('.portal-account-menu > summary');
    await expect(summary).toHaveText('My account');
    await expect(summary.locator('.account-photo-fallback')).toHaveCount(0);
    await summary.click();
    await expect(account.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
    await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(account.getByRole('navigation', { name: 'Switch workspace' })).toBeVisible();
  }
});

test('Patient header uses the shared My account menu and existing actions', async ({ page }) => {
  await page.goto('/patient');
  await page.evaluate(async () => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    const root = document.querySelector('.site-header .auth-bar');
    root.replaceChildren();
    mountAuthBar(root, { getState: () => ({ status: 'SIGNED_IN', user: { displayName: 'Alex Patient', email: 'alex@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['patient'] } } }), subscribe: () => () => {}, signIn: () => {}, signOut: () => {} });
  });
  const account = page.locator('.site-header .portal-account-menu');
  await expect(account.locator('summary')).toHaveText('My account');
  await expect(account.locator('summary .patient-avatar')).toHaveCount(0);
  await account.locator('summary').click();
  await expect(account.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('authenticated unauthorized users are not presented as signed out', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderAccessBoundary } = await import('/src/app/router.js');
    const root = document.createElement('section'); root.id = 'access-test'; document.body.prepend(root);
    renderAccessBoundary(root, '/doctor', {
      status: 'SIGNED_IN', user: { displayName: 'Alex Patient', email: 'alex@example.invalid' },
      authorizationStatus: 'READY', identity: { user: { roles: [] }, demoAccess: false, liveAvailable: false },
    });
  });
  const root = page.locator('#access-test');
  await expect(root).toContainText('Signed in as Alex Patient');
  await expect(root.getByRole('heading', { name: 'Doctor profile setup' })).toBeVisible();
  await expect(root).toContainText('An administrator must review and approve it.');
  await expect(root.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await expect(root.locator('.doctor-access-shell')).toBeVisible();
  await expect(root.locator('.doctor-access-workspace')).toHaveCount(0);
});

test('Doctor profile setup mounts the shared top navigation while approval is pending', async ({ page }) => {
  await page.goto('/');
  await page.locator('.site-header .landing-nav').evaluate(nav => nav.remove());
  await page.evaluate(async () => {
    window.history.replaceState({}, '', '/doctor');
    const { renderAccessBoundary } = await import('/src/app/router.js');
    window.disposeDoctorSetupNav = renderAccessBoundary(document.querySelector('main'), '/doctor', {
      status: 'SIGNED_IN', user: { displayName: 'Dr. Applicant', email: 'applicant@example.invalid' },
      authorizationStatus: 'READY', identity: { user: { roles: ['patient'] } },
    });
  });
  await expect(page.getByRole('heading', { name: 'Doctor profile setup' })).toBeVisible();
  const nav = page.locator('.site-header .landing-nav');
  await expect(nav).toHaveCount(1);
  await expect(nav.locator('.landing-nav-links a')).toHaveText(['Home', 'Portals', 'How It Works', 'Technology', 'About']);
  await expect(nav.locator('[aria-current]')).toHaveCount(0);
  await page.evaluate(() => window.disposeDoctorSetupNav());
  await expect(nav).toHaveCount(0);
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 412, height: 915 }]) {
  test(`Doctor cold-load access shell matches the protected workspace on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.locator('body').evaluate(body => body.classList.remove('landing-active'));
    await page.evaluate(async () => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      renderAccessBoundary(document.querySelector('main'), '/doctor', {
        status: 'AUTH_LOADING', user: null, authorizationStatus: 'IDLE', identity: null,
      });
    });

    const main = page.locator('main');
    const brand = page.locator('.site-header .smartcareops-brand-mark');
    await expect(brand).toHaveClass(/landing-brand-mark/);
    await expect(brand.locator('i')).toHaveCount(2);
    await expect(page.locator('.site-header .brand')).toContainText('SmartCareOps');
    await expect(main.getByRole('heading', { name: 'SmartCareOps / Doctor workspace · Fictional demo' })).toBeVisible();
    await expect(main.getByRole('status', { name: 'Restoring your session' })).toHaveText('Restoring your secure session…');
    await expect(main.locator('.doctor-access-workspace')).toBeVisible();
    await expect(main.locator('.doctor-card, #doctor-cases, #doctor-detail')).toHaveCount(0);
    await expect(main).not.toContainText('Patient Name');
    const loadingWorkspace = await main.locator('.doctor-access-workspace').boundingBox();

    await page.evaluate(async () => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      renderAccessBoundary(document.querySelector('main'), '/doctor', {
        status: 'SIGNED_IN', user: { uid: 'doctor-1' }, authorizationStatus: 'CHECKING', identity: null,
      });
    });
    await expect(main.getByRole('status', { name: 'Checking portal access' })).toHaveText('Checking your portal access…');
    await expect(main.locator('.doctor-card, #doctor-cases, #doctor-detail')).toHaveCount(0);

    await page.route('**/api/doctor/cases', async route => {
      await new Promise(resolve => setTimeout(resolve, 350));
      await route.fulfill({ json: { cases: [], nextCursor: null, storage: 'memory' } });
    });
    await page.evaluate(async () => {
      const [{ renderDoctor, mountDoctor }] = await Promise.all([import('/src/pages/doctor/index.js')]);
      const main = document.querySelector('main');
      main.innerHTML = renderDoctor();
      window.__doctorColdLoadCleanup = mountDoctor(main);
    });

    await expect(brand).toHaveClass(/landing-brand-mark/);
    await expect(brand.locator('i')).toHaveCount(2);
    await expect(page.locator('.site-header .brand')).toContainText('SmartCareOps');
    await expect(main.getByRole('status')).toHaveText('Loading routed cases…');
    const loadedWorkspace = await main.locator('.doctor-workspace-grid').boundingBox();
    expect(Math.abs(loadedWorkspace.x - loadingWorkspace.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(loadedWorkspace.width - loadingWorkspace.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(loadedWorkspace.y - loadingWorkspace.y)).toBeLessThanOrEqual(48);
    await expect(main.getByRole('status')).toHaveText('No routed cases yet.');
    await expect(main.locator('.doctor-card')).toHaveCount(0);
    await page.evaluate(() => { window.__doctorColdLoadCleanup?.(); });
    await expect(brand).toBeVisible();
    await expect(brand.locator('i')).toHaveCount(2);
  });
}

test('Doctor authorization failure stays explicit and exposes no workspace data', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderAccessBoundary } = await import('/src/app/router.js');
    renderAccessBoundary(document.querySelector('main'), '/doctor', {
      status: 'SIGNED_IN', user: { displayName: 'Alex Doctor', email: 'doctor@example.invalid' },
      authorizationStatus: 'ERROR', identity: null,
    });
  });
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Portal access could not be checked' })).toBeVisible();
  await expect(main).toContainText('Your Google session is active');
  await expect(main.locator('.doctor-access-workspace, .doctor-card, #doctor-cases, #doctor-detail')).toHaveCount(0);
});

test('authenticated patient remains limited to intake and status presentation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderAccessBoundary } = await import('/src/app/router.js');
    const root = document.createElement('section'); root.id = 'patient-access-test'; document.body.prepend(root);
    renderAccessBoundary(root, '/patient', {
      status: 'SIGNED_IN', user: { displayName: 'Alex Patient' }, authorizationStatus: 'READY',
      identity: { user: { roles: ['patient'] }, demoAccess: true, liveAvailable: false },
    });
  });
  const root = page.locator('#patient-access-test');
  await expect(root).toContainText('Patient intake and status');
  await expect(root).toContainText('Your identity has been verified');
  await expect(root).not.toContainText('Approve simulation');
  await expect(root.locator('#start-conversation')).toHaveCount(0);
});

test('privileged portal rendering still requires a backend-owned role', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { resolvePortalAccess } = await import('/src/app/router.js');
    const base = { status: 'SIGNED_IN', user: { uid: 'verified-user' }, authorizationStatus: 'READY', identity: { user: { roles: [] }, demoAccess: false, liveAvailable: false } };
    return {
      denied: resolvePortalAccess('/dispatcher', base),
      allowed: resolvePortalAccess('/dispatcher', { ...base, identity: { ...base.identity, demoAccess: true, user: { roles: ['dispatcher'] } } }),
    };
  });
  expect(results).toEqual({ denied: 'UNAUTHORIZED', allowed: 'AUTHORIZED' });
});

test('Doctor access presents a pending specialty application without granting a role', async ({ page }) => {
  let submitted;
  await page.route('**/api/profile', route => route.fulfill({ json: { profile: { uid: 'applicant', roles: ['patient'], doctorApplication: null } } }));
  await page.route('**/api/doctor/application', async route => { submitted = route.request().postDataJSON(); await route.fulfill({ json: { application: { status: 'pending' } } }); });
  await page.goto('/');
  const access = await page.evaluate(async () => {
    const { renderAccessBoundary, resolvePortalAccess } = await import('/src/app/router.js');
    const auth = { status: 'SIGNED_IN', user: { uid: 'applicant', displayName: 'Patient Applicant', email: 'applicant@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['patient'] } } };
    renderAccessBoundary(document.querySelector('main'), '/doctor', auth);
    return { result: resolvePortalAccess('/doctor', auth), unverifiedRole: resolvePortalAccess('/doctor', { ...auth, identity: { user: { roles: ['doctor'] } } }), verifiedDoctor: resolvePortalAccess('/doctor', { ...auth, identity: { user: { roles: ['doctor'], specialties: ['orthopedics'] } } }), markup: document.querySelector('main').innerText };
  });
  expect(access.result).toBe('UNAUTHORIZED');
  expect(access.unverifiedRole).toBe('UNAUTHORIZED');
  expect(access.verifiedDoctor).toBe('AUTHORIZED');
  expect(access.markup).toContain('Request Doctor workspace access');
  expect(access.markup).toContain('does not grant Doctor access');
  const main = page.locator('main');
  await main.getByLabel('Display name').fill('Dr Sample'); await main.getByLabel('Requested specialty').selectOption('orthopedics');
  await main.getByRole('button', { name: 'Submit for administrator review' }).click();
  await expect(main.getByRole('status')).toHaveText('Application submitted and pending administrator verification. This does not grant Doctor access.');
  expect(submitted).toEqual({ displayName: 'Dr Sample', specialty: 'orthopedics' });
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 360, height: 800 }]) {
  test(`Doctor application gives safe display-name guidance and pending feedback on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const submitted = [];
    let rejectFirstValid = true;
    await page.route('**/api/profile', route => route.fulfill({ json: { profile: { uid: 'applicant', roles: ['patient'], doctorApplication: null } } }));
    await page.route('**/api/doctor/application', route => {
      submitted.push(route.request().postDataJSON());
      if (rejectFirstValid) {
        rejectFirstValid = false;
        return route.fulfill({ status: 400, json: { code: 'INVALID_DOCTOR_DISPLAY_NAME', message: 'internal Firestore detail must not be shown' } });
      }
      return route.fulfill({ json: { application: { status: 'pending' } } });
    });
    await page.goto('/');
    await page.evaluate(async () => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      renderAccessBoundary(document.querySelector('main'), '/doctor', { status: 'SIGNED_IN', user: { uid: 'applicant' }, authorizationStatus: 'READY', identity: { user: { roles: ['patient'] } } });
    });
    const main = page.locator('main');
    const name = main.getByLabel('Display name');
    const submit = main.getByRole('button', { name: 'Submit for administrator review' });
    const status = main.locator('#doctor-application-status');
    await expect(main.locator('#doctor-application-name-help')).toContainText('Dr. Louie');
    expect((await submit.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await submit.click();
    await expect(status).toContainText('letters (including accents)');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await name.fill('Dr. Louie!');
    await submit.click();
    await expect(status).toContainText('apostrophes, hyphens');
    expect(submitted).toHaveLength(0);
    await name.fill(' Dr. Louie ');
    await main.getByLabel('Requested specialty').selectOption('orthopedics');
    await submit.click();
    await expect(status).toContainText('for example Dr. Louie');
    await expect(status).not.toContainText('Firestore');
    await expect(name).toBeFocused();
    expect(submitted).toEqual([{ displayName: 'Dr. Louie', specialty: 'orthopedics' }]);
    await submit.click();
    await expect(status).toHaveText('Application submitted and pending administrator verification. This does not grant Doctor access.');
    expect(submitted).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Patient Portal presents a request form when approved-only access blocks the account', async ({ page }) => {
  let submitted;
  await page.route('**/api/profile', route => route.fulfill({ json: { profile: { uid: 'patient-applicant', roles: [], patientApplication: null } } }));
  await page.route('**/api/patient/application', async route => { submitted = route.request().postDataJSON(); await route.fulfill({ json: { application: { status: 'pending' } } }); });
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderAccessBoundary } = await import('/src/app/router.js');
    renderAccessBoundary(document.querySelector('main'), '/patient', { status: 'SIGNED_IN', user: { uid: 'patient-applicant', displayName: 'Patient Applicant', email: 'patient@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: [] }, patientAccessMode: 'approved_only', liveAvailable: false } });
  });
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Request Patient Portal access' })).toBeVisible();
  await main.getByRole('checkbox').check();
  await main.getByRole('button', { name: 'Request access' }).click();
  await expect(main.getByRole('status')).toHaveText('Request submitted. Patient Portal access remains blocked until administrator approval.');
  expect(submitted).toEqual({ confirm: true });
});

test('hosted Patient Live bootstraps before WebSocket and never puts Firebase credentials in its URL', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const calls = [];
    class Socket {
      constructor(url, protocols) { this.url = String(url); this.protocols = protocols; calls.push({ url: this.url, protocols }); }
    }
    const token = 'A'.repeat(43);
    const fetchSession = async (path, options) => ({ ok: true, json: async () => ({
      token, intakeSessionId: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), webSocketUrl: 'wss://live.example.invalid/api/live', preferredLanguage: 'en',
    }), path, options });
    await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location });
    return calls[0];
  });
  expect(result.url).toBe('wss://live.example.invalid/api/live');
  expect(result.url).not.toContain('token');
  expect(result.protocols).toEqual(['smartcareops.live.v1', `smartcareops.session.${'A'.repeat(43)}`]);
});

test('direct Patient Live sends media to Google with an ephemeral token and keeps questions on the authenticated backend', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const calls = [], sockets = [];
    class Socket {
      constructor(url) { this.url = String(url); this.readyState = 0; this.sent = []; sockets.push(this); }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.({}); }
      message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const fetchSession = async (path, options = {}) => {
      calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
      if (path === '/api/live/session') return { ok: true, json: async () => ({ geminiToken: 'auth_tokens/direct-test-token', model: 'gemini-3.8-live',
        intakeSessionId: 'a'.repeat(64), preferredLanguage: 'en', expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
      return { ok: true, json: async () => ({ sessionId: 'a'.repeat(64), revision: 0, status: 'collecting',
        question: 'What name would you like me to use?', messages: [{ role: 'SmartCareOps', text: 'What name would you like me to use?' }],
        intake: {}, progress: { phase: 'core', status: 'collecting', path: null, answered: 0, total: 1 } }) };
    };
    const socket = await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location, preferredLanguage: 'en' });
    let opened = false; socket.onopen = () => { opened = true; socket.send(JSON.stringify({ type: 'start' })); };
    sockets[0].open(); sockets[0].message({ setupComplete: {} });
    return { url: sockets[0].url, calls, setup: sockets[0].sent[0], prompt: sockets[0].sent[1], opened, intakeSessionId: socket.smartcareIntakeSessionId };
  });
  expect(result.url).toContain('generativelanguage.googleapis.com');
  expect(result.url).toContain('access_token=auth_tokens%2Fdirect-test-token');
  expect(result.calls.map(call => call.path)).toEqual(['/api/live/session', '/api/intake/chat/session']);
  expect(result.calls[1].body).toEqual({ intakeSessionId: 'a'.repeat(64) });
  expect(result.setup.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(2000);
  expect(result.prompt.clientContent.turnComplete).toBe(true);
  expect(result.prompt.clientContent.turns[0].parts[0].text).toContain('What name would you like me to use?');
  expect(result.prompt.clientContent.turns[0].parts[0].text).not.toContain('Your intake is complete.');
  expect(result.opened).toBe(true);
  expect(result.intakeSessionId).toBe('a'.repeat(64));
});

test('local Patient Live uses the direct token bootstrap instead of the legacy relay', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const calls = [], sockets = [];
    class Socket {
      constructor(url) { this.url = String(url); this.readyState = 0; sockets.push(this); }
      send() {}
      close() { this.readyState = 3; }
    }
    const fetchSession = async path => {
      calls.push(path);
      if (path === '/api/live/session') return { ok: true, json: async () => ({ geminiToken: 'auth_tokens/local-direct-test-token', model: 'gemini-3.8-live',
        intakeSessionId: 'c'.repeat(64), preferredLanguage: 'en', expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
      return { ok: true, json: async () => ({ sessionId: 'c'.repeat(64), revision: 0, status: 'collecting',
        question: 'What name would you like me to use?', messages: [{ role: 'SmartCareOps', text: 'What name would you like me to use?' }], intake: {},
        progress: { phase: 'core', status: 'collecting', path: null, answered: 0, total: 1 } }) };
    };
    await openLiveSocket({ authenticated: false, fetchSession, Socket, location: window.location });
    return { calls, url: sockets[0].url };
  });
  expect(result.calls).toEqual(['/api/live/session', '/api/intake/chat/session']);
  expect(result.url).toContain('generativelanguage.googleapis.com');
  expect(result.url).not.toContain('/api/live');
});

test('direct Patient Live discards Gemini autonomous speech and speaks only the backend-approved next question', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const sockets = [], backendMessages = [];
    class Socket {
      constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.({}); }
      message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const fetchSession = async (path, options = {}) => {
      if (path === '/api/live/session') return { ok: true, json: async () => ({ geminiToken: 'auth_tokens/direct-test-token', model: 'gemini-3.8-live',
        intakeSessionId: 'b'.repeat(64), preferredLanguage: 'en', expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
      if (path === '/api/intake/chat/session') return { ok: true, json: async () => ({ sessionId: 'b'.repeat(64), revision: 0, status: 'collecting',
        question: 'What name would you like me to use?', messages: [{ role: 'SmartCareOps', text: 'What name would you like me to use?' }], intake: {},
        progress: { phase: 'core', status: 'collecting', path: null, answered: 0, total: 1 } }) };
      backendMessages.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ sessionId: 'b'.repeat(64), revision: 1, status: 'collecting', question: 'What are you feeling today?',
        messages: [{ role: 'SmartCareOps', text: 'What name would you like me to use?' }, { role: 'Patient', text: 'JL' },
          { role: 'SmartCareOps', text: 'Thank you, JL. What are you feeling today?' }], intake: { patient: { name: 'JL' } },
        progress: { phase: 'core', status: 'collecting', path: null, answered: 1, total: 2 } }) };
    };
    const socket = await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location, preferredLanguage: 'en' });
    const received = [];
    socket.onmessage = event => received.push(JSON.parse(event.data));
    socket.onopen = () => socket.send(JSON.stringify({ type: 'start' }));
    const upstream = sockets[0]; upstream.open(); upstream.message({ setupComplete: {} });
    upstream.message({ serverContent: { outputTranscription: { text: 'What name would you like me to use?', finished: true },
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] }, turnComplete: true } });
    socket.send(JSON.stringify({ type: 'audio', data: 'AQI=', sampleRate: 16000 }));
    upstream.message({ serverContent: { inputTranscription: { text: 'JL', finished: false },
      outputTranscription: { text: 'Autonomous model reply that must be discarded.', finished: true },
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }] }, turnComplete: true } });
    await new Promise(resolve => setTimeout(resolve, 0));
    return { backendMessages, received, sent: upstream.sent };
  });
  expect(result.backendMessages).toEqual([{ sessionId: 'b'.repeat(64), expectedRevision: 0, message: 'JL' }]);
  expect(result.received.some(item => item.role === 'Gemini' && item.text.includes('Autonomous'))).toBe(false);
  expect(result.received.some(item => item.type === 'audio' && item.data === 'BBBB')).toBe(false);
  const prompts = result.sent.filter(item => item.clientContent).map(item => item.clientContent.turns[0].parts[0].text);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('Thank you, JL. What are you feeling today?');
});

test('direct Patient Live submits finalized input transcription without waiting for turnComplete', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const sockets = [], backendMessages = [];
    class Socket {
      constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.({}); }
      message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const fetchSession = async (path, options = {}) => {
      if (path === '/api/live/session') return { ok: true, json: async () => ({ geminiToken: 'auth_tokens/direct-test-token', model: 'gemini-3.8-live',
        intakeSessionId: 'd'.repeat(64), preferredLanguage: 'en', expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
      if (path === '/api/intake/chat/session') return { ok: true, json: async () => ({ sessionId: 'd'.repeat(64), revision: 2, status: 'collecting',
        question: 'How severe is it from 1 to 10, with 10 being the most severe?', messages: [{ role: 'SmartCareOps', text: 'How severe is it from 1 to 10, with 10 being the most severe?' }], intake: {},
        progress: { phase: 'core', status: 'collecting', path: 'general', answered: 2, total: 5 } }) };
      backendMessages.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ sessionId: 'd'.repeat(64), revision: 3, status: 'collecting',
        question: 'Is this new, recurring, or related to a condition you already know about?',
        messages: [{ role: 'SmartCareOps', text: 'How severe is it from 1 to 10, with 10 being the most severe?' }, { role: 'Patient', text: 'eight' },
          { role: 'SmartCareOps', text: 'Is this new, recurring, or related to a condition you already know about?' }], intake: {},
        progress: { phase: 'core', status: 'collecting', path: 'general', answered: 3, total: 5 } }) };
    };
    const socket = await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location });
    const received = [];
    socket.onmessage = event => received.push(JSON.parse(event.data));
    socket.onopen = () => socket.send(JSON.stringify({ type: 'start' }));
    const upstream = sockets[0]; upstream.open(); upstream.message({ setupComplete: {} });
    upstream.message({ serverContent: { outputTranscription: { text: 'How severe is it from 1 to 10, with 10 being the most severe?' }, turnComplete: true } });
    received.length = 0;
    socket.send(JSON.stringify({ type: 'audio', data: 'AQI=', sampleRate: 16000 }));
    upstream.message({ serverContent: { inputTranscription: { text: 'eight' } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    upstream.message({ serverContent: { turnComplete: true } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const prematureBoundaries = received.filter(item => item.type === 'turn-complete').length;
    upstream.message({ serverContent: { outputTranscription: { text: 'Is this new, recurring, or related to a condition you already know about?' }, turnComplete: true } });
    return { backendMessages, prematureBoundaries, completedBoundaries: received.filter(item => item.type === 'turn-complete').length,
      prompts: upstream.sent.filter(item => item.clientContent).map(item => item.clientContent.turns[0].parts[0].text) };
  });
  expect(result.backendMessages).toEqual([{ sessionId: 'd'.repeat(64), expectedRevision: 2, message: 'eight' }]);
  expect(result.prompts.at(-1)).toContain('Is this new, recurring, or related to a condition you already know about?');
  expect(result.prematureBoundaries).toBe(0);
  expect(result.completedBoundaries).toBe(1);
});

test('authorized Patient sees Start Conversation and every connection requests a fresh session', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { resolvePortalAccess } = await import('/src/app/router.js');
    const { renderPatient } = await import('/src/pages/patient/index.js');
    const { openLiveSocket } = await import('/src/pages/patient/conversation.js');
    const access = resolvePortalAccess('/patient', {
      status: 'SIGNED_IN', user: { uid: 'patient' }, authorizationStatus: 'READY',
      identity: { user: { roles: ['patient'] }, liveAvailable: true },
    });
    const calls = [], urls = [];
    class Socket { constructor(url) { urls.push(String(url)); } }
    const fetchSession = async () => {
      const token = String.fromCharCode(65 + calls.length).repeat(43); calls.push(token);
      return { ok: true, json: async () => ({ token, intakeSessionId: token.charCodeAt(0).toString(16).padStart(2, '0').repeat(32), expiresAt: new Date(Date.now() + 60_000).toISOString(), webSocketUrl: 'wss://live.example.invalid/api/live', preferredLanguage: 'en' }) };
    };
    await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location });
    await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location });
    return { access, markup: renderPatient(), calls, urls };
  });
  expect(result.access).toBe('AUTHORIZED');
  expect(result.markup).toContain('Start Conversation');
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]).not.toBe(result.calls[1]);
  expect(result.urls).toEqual(['wss://live.example.invalid/api/live', 'wss://live.example.invalid/api/live']);
  expect(JSON.stringify(result)).not.toContain('firebase-token');
});

test('signed-out and non-Patient identities cannot reach the hosted Live workspace', async ({ page }) => {
  await page.goto('/');
  const states = await page.evaluate(async () => {
    const { resolvePortalAccess } = await import('/src/app/router.js');
    return {
      signedOut: resolvePortalAccess('/patient', { status: 'SIGNED_OUT', user: null }),
      nonPatient: resolvePortalAccess('/patient', { status: 'SIGNED_IN', user: { uid: 'doctor' }, authorizationStatus: 'READY', identity: { user: { roles: ['doctor'] }, liveAvailable: false } }),
    };
  });
  expect(states).toEqual({ signedOut: 'SIGNED_OUT', nonPatient: 'UNAUTHORIZED' });
});

test('stored command_center role authorizes the Command Center route alias', async ({ page }) => {
  await page.goto('/');
  const access = await page.evaluate(async () => {
    const { resolvePortalAccess } = await import('/src/app/router.js');
    return resolvePortalAccess('/command-center', { status: 'SIGNED_IN', user: { uid: 'staff' }, authorizationStatus: 'READY', identity: { user: { roles: ['patient', 'command_center'] } } });
  });
  expect(access).toBe('AUTHORIZED');
});

for (const path of ['/patient', '/doctor', '/dispatcher', '/command-center']) {
  test(`SPA entry and refresh preserve ${path}`, async ({ page }) => {
    await page.goto(path); await page.reload();
    await expect(page.locator('#page-heading')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  });
}
