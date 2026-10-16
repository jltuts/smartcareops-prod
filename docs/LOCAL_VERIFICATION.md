# Local verification

Use Node.js 24 and npm. Start from a clean clone without real `.env` files or cloud credentials. Install locked dependencies with `npm ci` in the root, `backend`, and `agent-runtime/clinical-shadow` directories.

## Offline application checks

After dependency installation:

```sh
npm run build
npm --prefix backend test
npm --prefix agent-runtime/clinical-shadow test
node --test tests/maps-build-config.test.js
```

These checks build the frontend and exercise controlled test adapters. Building `dist` does not deploy it. A production preview requires Firebase configuration; compilation alone is sufficient for source/build review.

## Browser checks

```sh
npx playwright install chromium
npm run test:e2e
```

The test setup owns local API and Vite servers and uses fictional fixtures. Ports 4173 and 8080 must be free. Browser emulation is not physical-mobile audio verification. Do not run browser checks against the deployed demonstration.

## Interactive inspection

The example environment files contain no credentials. They describe local memory storage and local-demo authentication, which are development-only modes. The backend does not automatically load its example file; configure process variables explicitly if starting it manually. Real Gemini calls require your own server-side key and may incur usage charges. Do not put a Gemini key in a `VITE_` variable.

The unchanged source includes environment-bound authentication checks and cloud adapters. This showcase is not a turnkey cloud installation. Live authentication, maps, voice, clinical runtime, and provider integrations need separate configuration and acceptance. Do not use deployment scripts or infrastructure apply commands from this repository.

## Publication checks

Run `python backend/scripts/scan-secrets.py` after staging the intended snapshot. This is a pattern scanner with limited coverage, not a guarantee that every kind of sensitive information is absent. Review document metadata and Git history as well as current files. See `SECURITY.md`.
