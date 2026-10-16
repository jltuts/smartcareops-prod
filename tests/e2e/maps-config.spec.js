import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const testKey = 'maps-browser-test-key';

test('a supplied browser key loads Maps JavaScript and initializes the shared map component', async ({ page }) => {
  let requestedKey;
  await page.route('https://maps.googleapis.com/maps/api/js**', async route => {
    requestedKey = new URL(route.request().url()).searchParams.get('key');
    const callback = new URL(route.request().url()).searchParams.get('callback');
    const body = `class Overlay { constructor(options) { this.options = options; } setMap() {} }
      class MapStub { fitBounds() {} }
      class Bounds { extend() {} isEmpty() { return false; } }
      window.google = { maps: { Map: MapStub, Marker: Overlay, Circle: Overlay, Polyline: Overlay, LatLngBounds: Bounds, SymbolPath: { FORWARD_CLOSED_ARROW: 1 } } };
      window[${JSON.stringify(callback)}]();`;
    await route.fulfill({ status: 200, contentType: 'application/javascript', body });
  });
  await page.goto('/');
  await page.evaluate(async key => {
    const mapsModule = await import('/src/components/operational-map.js');
    await mapsModule.loadGoogleMaps(key);
    const root = document.createElement('div');
    root.innerHTML = mapsModule.operationalMapMarkup({ id: 'maps-test', title: 'Map test', description: 'Test map' });
    document.body.append(root);
    mapsModule.renderOperationalMap(root);
    await new Promise(resolve => setTimeout(resolve, 0));
  }, testKey);
  expect(requestedKey).toBe(testKey);
  await expect(page.locator('#maps-test .google-map-canvas')).toHaveAttribute('data-map-ready', 'true');
});

test('a missing browser key leaves the honest Maps configuration fallback', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const mapsModule = await import('/src/components/operational-map.js');
    const root = document.createElement('div');
    root.innerHTML = mapsModule.operationalMapMarkup({ id: 'maps-test', title: 'Map test', description: 'Test map' });
    document.body.append(root);
    mapsModule.renderOperationalMap(root);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await expect(page.locator('#maps-test .map-status')).toHaveText('Google Maps is not configured. Add the restricted public browser key to enable this view.');
  await expect(page.locator('#maps-test .google-map-canvas')).toHaveAttribute('data-map-ready', 'false');
});

test('Command Center, Dispatcher, and Patient share one Maps loader and one environment variable name', async () => {
  const files = [
    'src/pages/command-center/simulation.js',
    'src/pages/dispatcher/index.js',
    'src/pages/patient/case-card.js',
  ];
  for (const file of files) expect(await readFile(file, 'utf8')).toContain("'../../components/operational-map.js'");
  const source = await readFile('src/components/operational-map.js', 'utf8');
  expect(source.match(/(?:VITE_)?GOOGLE_MAPS_(?:BROWSER|API)_KEY/g)).toEqual(['VITE_GOOGLE_MAPS_BROWSER_KEY']);
});
