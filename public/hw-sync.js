/* Homeweavers Attendance — server-backed storage adapter.
 *
 * Must load BEFORE the dashboard script. The dashboard begins with:
 *     var storage = (window.storage && typeof window.storage.get === 'function')
 *                     ? window.storage : (localStorage shim)
 * so defining window.storage here redirects every existing settings call to
 * Postgres without touching those call sites.
 *
 * Values are cached in memory and hydrated in one request at boot, because the
 * dashboard does ~30 sequential storage.get() calls during startup and a round
 * trip each would be visibly slow.
 */
(function () {
  'use strict';

  var cache = Object.create(null);
  var hydrated = false;

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) { window.HWAuth && window.HWAuth.onExpired(); throw new Error('not_authenticated'); }
      return res.json().catch(function () { return null; });
    });
  }

  window.HWSync = {
    hydrate: function () {
      return api('GET', '/api/kv-all').then(function (r) {
        cache = (r && r.values) || Object.create(null);
        hydrated = true;
        return cache;
      });
    },
    cached: function () { return cache; }
  };

  window.storage = {
    get: function (key, shared) {
      // Served from cache so boot stays fast; hydrate() ran before the app did.
      if (hydrated && Object.prototype.hasOwnProperty.call(cache, key)) {
        return Promise.resolve({ key: key, value: cache[key], shared: !!shared });
      }
      if (hydrated) return Promise.resolve(null);
      return api('GET', '/api/kv/' + encodeURIComponent(key) + '?shared=' + (shared !== false));
    },

    set: function (key, value, shared) {
      var v = String(value);
      cache[key] = v;                       // optimistic, so the UI stays snappy
      return api('PUT', '/api/kv/' + encodeURIComponent(key), { value: v, shared: shared !== false })
        .then(function () { return { key: key, value: v, shared: !!shared }; })
        .catch(function (e) {
          delete cache[key];                // roll back so we don't show a save that failed
          throw e;
        });
    },

    delete: function (key, shared) {
      delete cache[key];
      return api('DELETE', '/api/kv/' + encodeURIComponent(key) + '?shared=' + (shared !== false))
        .then(function () { return { key: key, deleted: true, shared: !!shared }; });
    },

    list: function (prefix, shared) {
      return api('GET', '/api/kv?prefix=' + encodeURIComponent(prefix || '') + '&shared=' + (shared !== false));
    }
  };

  /* ---- live sync: poll the change feed and refresh when someone else edits ---- */
  var cursor = 0, polling = false;

  window.HWLiveSync = {
    start: function (onRemoteChange) {
      if (polling) return;
      polling = true;
      api('GET', '/api/changes?since=0').then(function (r) { cursor = (r && r.cursor) || 0; });

      setInterval(function () {
        if (document.hidden) return;   // don't poll a background tab
        api('GET', '/api/changes?since=' + cursor).then(function (r) {
          if (!r || !r.changes || !r.changes.length) return;
          // Ignore changes this user made themselves - their UI is already right.
          var fromOthers = r.changes.filter(function (c) { return c.changed_by !== r.self; });
          cursor = r.cursor;
          if (fromOthers.length) {
            window.HWSync.hydrate().then(function () {
              if (typeof onRemoteChange === 'function') onRemoteChange(fromOthers);
            });
          }
        }).catch(function () { /* transient network errors are not fatal */ });
      }, 5000);
    }
  };
})();
