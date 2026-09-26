const localhostNames = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeOrigin(value, { allowLocalHttp = false } = {}) {
  if (typeof value !== 'string' || !value || value === 'null' || value.includes('*')) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    const local = localhostNames.has(url.hostname);
    if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}`;
  } catch { return null; }
}

export function createOriginPolicy(origins = []) {
  const allowed = new Set();
  for (const configured of origins) {
    const normalized = normalizeOrigin(configured, { allowLocalHttp: true });
    if (normalized) allowed.add(normalized);
  }
  return Object.freeze({
    allowed: Object.freeze([...allowed]),
    validate(value) {
      const normalized = normalizeOrigin(value, { allowLocalHttp: true });
      return normalized && allowed.has(normalized) ? normalized : null;
    },
  });
}

// Fetch Metadata is defense-in-depth. Browsers do not consistently send every
// field on WebSocket handshakes, and the Hosting -> run.app hop is cross-site.
export function browserSignalsAccept(headers = {}, { webSocket = false } = {}) {
  const mode = headers['sec-fetch-mode'];
  const dest = headers['sec-fetch-dest'];
  const modes = webSocket ? ['websocket'] : ['cors', 'same-origin'];
  const destinations = webSocket ? ['websocket', 'empty'] : ['empty'];
  return (!mode || modes.includes(mode)) && (!dest || destinations.includes(dest));
}
