import { pathToFileURL } from 'node:url';

export function mapsBrowserKeyConfigured(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\r\n"']/.test(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!mapsBrowserKeyConfigured(process.env.VITE_GOOGLE_MAPS_BROWSER_KEY)) {
    console.error('Hosting build stopped: set VITE_GOOGLE_MAPS_BROWSER_KEY to the restricted public Maps JavaScript browser key.');
    process.exitCode = 1;
  }
}
