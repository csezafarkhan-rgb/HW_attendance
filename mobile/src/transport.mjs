export const API_ORIGIN = 'https://attendance.homeweavers.net';

// Only the existing first-party API is eligible for native authenticated HTTP.
// Blob downloads, local assets and external links never receive API cookies.
export function apiURL(input, localOrigin = 'https://localhost') {
  const raw = typeof input === 'string' ? input : input?.url;
  if (!raw) return null;
  const url = new URL(raw, localOrigin);
  if (![localOrigin, API_ORIGIN].includes(url.origin)) return null;
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') return null;
  return API_ORIGIN + url.pathname + url.search;
}

export function nativeOptions(url, init = {}) {
  const headers = Object.fromEntries(new Headers(init.headers || {}));
  // Credentials stay in the native cookie jar. Do not expose them to JavaScript.
  delete headers.cookie;
  delete headers.host;
  let data = init.body;
  if (data != null && typeof data !== 'string') throw new TypeError('Expected a JSON API body');
  if (data && /application\/json/i.test(headers['content-type'] || '')) data = JSON.parse(data);
  return {
    url, method: (init.method || 'GET').toUpperCase(), headers,
    ...(data != null ? { data } : {}), responseType: 'text',
    connectTimeout: 30000, readTimeout: 120000, disableRedirects: true
  };
}

export function safeFilename(name) {
  return String(name || 'attendance-export').split(/[\\/]/).pop()
    .replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0,160) || 'attendance-export';
}
