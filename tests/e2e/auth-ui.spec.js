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
        current = { status: 'SIGNED_IN', user: { displayName: 'Alex Patient', email: 'alex@example.invalid' }, error: null };
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

test('successful login updates identity immediately and sign-out restores signed-out UI', async ({ page }) => {
  const root = await mountAuthHarness(page, { status: 'SIGNED_OUT', user: null, error: null });
  await root.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(root).toContainText('Alex Patient');
  await expect(root).toContainText('alex@example.invalid');
  await expect(root.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(root).not.toContainText('Not signed in');
  await root.getByRole('button', { name: 'Sign out' }).click();
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
    mountAuthBar(root, { getState: () => ({ status: 'SIGNED_IN', user, error: null }), subscribe: () => () => {}, signIn: () => {}, signOut: () => {} });
  });
  await expect(page.locator('#restored-auth-test')).toContainText('Restored User');
  await expect(page.locator('#restored-auth-test').getByRole('button', { name: 'Sign out' })).toBeVisible();
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
  await expect(root).toContainText("You don't currently have access to the Doctor Portal.");
  await expect(root.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
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
      token, expiresAt: new Date(Date.now() + 60_000).toISOString(), webSocketUrl: 'wss://live.example.invalid/api/live',
    }), path, options });
    await openLiveSocket({ authenticated: true, fetchSession, Socket, location: window.location });
    return calls[0];
  });
  expect(result.url).toBe('wss://live.example.invalid/api/live');
  expect(result.url).not.toContain('token');
  expect(result.protocols).toEqual(['smartcareops.live.v1', `smartcareops.session.${'A'.repeat(43)}`]);
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
      return { ok: true, json: async () => ({ token, expiresAt: new Date(Date.now() + 60_000).toISOString(), webSocketUrl: 'wss://live.example.invalid/api/live' }) };
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
