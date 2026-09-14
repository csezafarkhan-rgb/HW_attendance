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

  function api(method, url, body, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function(){ controller.abort(); }, timeoutMs || 8000) : null;
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (res.status === 401) { window.HWAuth && window.HWAuth.onExpired(); throw new Error('not_authenticated'); }
      return res.json().catch(function () { return null; }).then(function (data) {
        /* Only 401 used to count as a failure. A save refused as too large (413),
           forbidden (403) or broken on the server (500) resolved like a success,
           so the change stayed on screen and was gone after a reload. */
        if (!res.ok) {
          var err = new Error((data && data.error) || ('http_' + res.status));
          err.status = res.status;
          err.data = data;                  // e.g. the months a locked-month refusal names
          throw err;
        }
        return data;
      });
    }).finally(function(){ if(timer) clearTimeout(timer); });
  }

  /* Say so when a save did not reach the server. Every caller in the dashboard
     only logs the error, so without this the person carries on editing work
     that will not be there tomorrow. A view-only account's refusals are left
     quiet: its editing controls are hidden already. */
  var noticeTimer = null;
  // What a person calls each stored setting, for the notice.
  var KEY_NAMES = {
    overrides: 'the attendance marks', halfDays: 'the part-day leave', leaveRequests: 'the leave requests',
    shiftAssignments: 'the shifts', dayShifts: 'the one-day shifts', satPolicy: 'the Saturday settings',
    joinDates: 'the joining dates', salaries: 'the salaries', payRules: 'the pay rules',
    officialLeaves: 'the holidays', manualRecords: 'the manual entries', lateExcuses: 'the late excuses',
    earlyExcuses: 'the early excuses', mispunchFlags: 'the mispunch flags', leaveDeductions: 'the leave deductions',
    manualLeave: 'the leave entered by hand', employeeOrder: 'the employee order', empNames: 'the display names',
    companyInfo: 'the company details', signatures: 'the signatures', customShifts: 'the shift list'
  };
  function monthName(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(ym));
    if (!m) return String(ym);
    try { return new Date(+m[1], +m[2] - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
    catch (_) { return String(ym); }
  }
  function saveFailed(what, e) {
    what = KEY_NAMES[String(what).replace(/"/g, '')] || what;
    if (e && (e.status === 403 || e.message === 'not_authenticated')) return;
    try {
      var el = document.getElementById('hwSaveFailed');
      if (!el) {
        el = document.createElement('div');
        el.id = 'hwSaveFailed';
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;'
          + 'max-width:min(92vw,560px);padding:11px 16px;border-radius:10px;background:#B3261E;color:#fff;'
          + 'font:600 13px/1.45 Inter,-apple-system,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.28);cursor:pointer;';
        el.title = 'Click to dismiss';
        el.addEventListener('click', function () { el.style.display = 'none'; });
        document.body.appendChild(el);
      }
      if (e && e.status === 409) {
        el.textContent = 'Not saved: someone else changed ' + what + ' after this page loaded it, so saving '
          + 'would have overwritten their change. Reload the page to see it, then make your change again.';
      } else if (e && e.status === 423) {
        var months = ((e.data && e.data.months) || []).map(monthName).join(', ');
        el.textContent = (months
            ? ('Not saved: ' + months + ' is locked because its pay has been run. ')
            : ('Not saved: ' + what + ' fall in a month that is locked because its pay has been run. '))
          + 'An admin can unlock it on the Payroll page; reload to put back what the page shows.';
      } else {
        var why = (e && e.status === 413) ? 'it is too large for the server to store'
                : (e && e.name === 'AbortError') ? 'the server did not answer in time'
                : 'the server could not store it';
        el.textContent = 'Not saved: the last change to ' + what + ' did not reach the server because ' + why
          + '. Reload the page and check before making more changes.';
      }
      el.style.display = 'block';
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(function () { el.style.display = 'none'; }, 20000);
    } catch (_) {}
  }

  /* Versions of shared keys. serverVersions is what the server last said;
     seen is what this page last actually read or wrote - the copy a save is
     made from, so it is what the save sends as baseVersion. A background
     refresh updates the first but not the second, or a stale page would look
     up to date and overwrite someone's change without being refused. */
  var serverVersions = Object.create(null);
  var seen = Object.create(null);
  var queues = Object.create(null);         // saves of one key, one after another

  window.HWSync = {
    hydrate: function () {
      return api('GET', '/api/kv-all').then(function (r) {
        cache = (r && r.values) || Object.create(null);
        serverVersions = (r && r.versions) || Object.create(null);
        hydrated = true;
        return cache;
      });
    },
    hydrateDataset: function () {
      // A waking free-tier database can take longer than 8 seconds to answer.
      return api('GET', '/api/dataset', undefined, 30000).then(function (r) {
        return (r && r.employees && r.records) ? r : {employees: [], records: []};
      });
    },
    saveDataset: function (dataset) {
      // Every row is upserted one by one, which on a full month outlasts 8 seconds;
      // aborting then reported a failure for a save that went on to succeed.
      return api('PUT', '/api/dataset', dataset || {employees: [], records: []}, 90000)
        .then(function (r) {
          // Rows in a locked month are skipped by the server; say so if any of them had changed.
          if (r && r.lockedChanged > 0) {
            saveFailed(r.lockedChanged + ' attendance row' + (r.lockedChanged === 1 ? '' : 's'),
                       { status: 423, data: { months: [] } });
          }
          return r;
        })
        .catch(function (e) { saveFailed('the attendance records', e); throw e; });
    },
    // A restore: the server's attendance becomes exactly this (see PUT /api/dataset?replace=1).
    replaceDataset: function (dataset) {
      return api('PUT', '/api/dataset?replace=1', dataset, 120000)
        .catch(function (e) { saveFailed('the restored attendance', e); throw e; });
    },
    cached: function () { return cache; }
  };

  window.storage = {
    get: function (key, shared) {
      // Served from cache so boot stays fast; hydrate() ran before the app did.
      if (hydrated && Object.prototype.hasOwnProperty.call(cache, key)) {
        if (serverVersions[key] != null) seen[key] = serverVersions[key];
        return Promise.resolve({ key: key, value: cache[key], shared: !!shared });
      }
      if (hydrated) return Promise.resolve(null);
      return api('GET', '/api/kv/' + encodeURIComponent(key) + '?shared=' + (shared !== false))
        .then(function (r) {
          if (r && r.version != null && shared !== false) { seen[key] = r.version; serverVersions[key] = r.version; }
          return r;
        });
    },

    set: function (key, value, shared) {
      var v = String(value);
      var isShared = shared !== false;
      var had = Object.prototype.hasOwnProperty.call(cache, key), before = cache[key];
      cache[key] = v;                       // optimistic, so the UI stays snappy
      var run = function () {
        var body = { value: v, shared: isShared };
        if (isShared && seen[key] != null) body.baseVersion = seen[key];
        return api('PUT', '/api/kv/' + encodeURIComponent(key), body)
          .then(function (r) {
            if (isShared && r && r.version != null) { seen[key] = r.version; serverVersions[key] = r.version; }
            return { key: key, value: v, shared: !!shared };
          })
          .catch(function (e) {
            /* Put back what was stored. Deleting it made the key read as empty
               for the rest of the session, as though it had never been saved. */
            if (had) cache[key] = before; else delete cache[key];
            saveFailed('"' + key + '"', e);
            throw e;
          });
      };
      /* One save of a key at a time, each sending the version the previous one
         returned. Two quick saves in a row would otherwise both send the same
         base, and the second would be refused as a conflict with the first. */
      var p = (queues[key] || Promise.resolve()).then(run, run);
      queues[key] = p.catch(function () {});
      return p;
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
      api('GET', '/api/changes?since=0').then(function (r) { cursor = (r && r.cursor) || 0; })
        .catch(function () { /* the next poll starts from 0 and catches up */ });

      setInterval(function () {
        if (document.hidden) return;   // don't poll a background tab
        api('GET', '/api/changes?since=' + cursor).then(function (r) {
          if (!r || !r.changes || !r.changes.length) return;
          // Ignore changes this user made themselves - their UI is already right.
          var fromOthers = r.changes.filter(function (c) { return c.changed_by !== r.self; });
          cursor = r.cursor;
          if (fromOthers.length) {
            var needsDataset = fromOthers.some(function(c){ return c.entity === 'records' || c.entity === 'employees'; });
            var refresh = needsDataset
              ? window.HWSync.hydrateDataset()
              : window.HWSync.hydrate();
            refresh.then(function (dataset) {
              if (typeof onRemoteChange === 'function') onRemoteChange(fromOthers, dataset);
            }).catch(function () { /* picked up on a later change */ });
          }
        }).catch(function () { /* transient network errors are not fatal */ });
      }, 2000);
    }
  };
})();
