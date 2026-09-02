/* Server-backed login gate for Homeweavers Attendance.
 *
 * Authentication is handled only by the Node/Express API.  This file is
 * intentionally self-contained so the sign-in button still works even if a
 * legacy dashboard script has a JavaScript error.
 */
(function () {
  'use strict';

  window.HWAuth = window.HWAuth || {};
  window.HWAuth.user = null;
  window.HWAuth.__booted = false;
  window.HWAuth.__reloading = false;
  window.HWAuth.onExpired = function () {
    if (window.HWAuth.__reloading) return;
    window.HWAuth.__reloading = true;
    location.reload();
  };

  function apiJson(url, options) {
    options = options || {};
    options.credentials = 'same-origin';
    options.headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;
    if (controller) options.signal = controller.signal;
    return fetch(url, options).then(function (r) {
      return r.text().then(function (text) {
        var body = {};
        try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { error: text || ('HTTP ' + r.status) }; }
        if (!r.ok) {
          var err = new Error(body.error || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return body;
      });
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function setupGate(startWorkspace) {
    if (window.HWAuth.__booted) return;
    var gate = document.getElementById('loginGate');
    if (!gate) return;
    window.HWAuth.__booted = true;

    var uEl = document.getElementById('lgUser');
    var pEl = document.getElementById('lgPass');
    var btn = document.getElementById('lgBtn');
    var form = document.getElementById('lgForm');
    var errEl = document.getElementById('lgErr');
    var who = document.getElementById('whoami');
    var outBtn = document.getElementById('logoutBtn');
    var usersBtn = document.getElementById('usersBtn');
    var pbBtn = document.getElementById('pbBtn');
    var sub = document.getElementById('lgTitleSub');
    var passField = document.getElementById('lgPassField');
    var backBtn = document.getElementById('lgBack');
    var rememberRow = document.getElementById('lgRememberRow');
    var lbl = document.querySelector('label[for="lgUser"]');

    if (passField) passField.style.display = '';
    if (backBtn) backBtn.style.display = 'none';
    if (rememberRow) rememberRow.style.display = '';
    var remEl = document.getElementById('lgRemember');
    if (btn) btn.textContent = 'Sign in';
    if (sub) sub.textContent = 'Sign in to open your dashboards';
    if (lbl) lbl.textContent = 'Username or email';
    if (uEl) {
      uEl.type = 'text';
      uEl.setAttribute('autocomplete', 'username');
      uEl.setAttribute('autocapitalize', 'none');
      uEl.setAttribute('spellcheck', 'false');
    }
    /* The gate carries a plain note now - self-service reset does not exist, and
       changing a password is done from inside the app, not from the sign-in card. */
    var fp = document.getElementById('lgFpNote');
    if (fp) fp.textContent = 'Forgot password? Contact Admin';

    function showError(message) {
      if (errEl) { errEl.textContent = message; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    }
    function clearError() {
      if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    }
    function enter(user) {
      window.HWAuth.user = user;
      var tierLabel = user.role === 'admin' ? ' · Super Admin'
                    : user.role === 'admin_view' ? ' · View Admin' : '';
      if (who) who.textContent = '👤 ' + (user.name || user.email) + tierLabel;
      if (outBtn) outBtn.style.display = '';
      /* Managing accounts and taking a whole-project backup are changes, so they
         belong to the super admin alone - a view admin gets neither button. */
      if (usersBtn) usersBtn.style.display = user.role === 'admin' ? '' : 'none';
      if (pbBtn) pbBtn.style.display = user.role === 'admin' ? '' : 'none';

      var ready = (window.HWSync && typeof window.HWSync.hydrate === 'function')
        ? window.HWSync.hydrate()
        : Promise.resolve();
      Promise.resolve(ready).catch(function () {}).then(function () {
        gate.classList.add('lg-out');
        setTimeout(function () { gate.style.display = 'none'; }, 380);
        if (typeof startWorkspace === 'function') startWorkspace('attendance');
        if (window.HWLiveSync && typeof window.HWLiveSync.start === 'function') {
          window.HWLiveSync.start(function (changes, dataset) {
            var fr = document.querySelector('#frames iframe[data-id="attendance"]');
            if (fr && fr.contentWindow) {
              try { fr.contentWindow.postMessage({ type: 'hw-remote-change', dataset: dataset || null }, '*'); } catch (e) {}
            }
          });
        }
      });
    }
    function submit(ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (btn && btn.disabled) return;
      var username = (uEl && uEl.value || '').trim();
      var password = (pEl && pEl.value) || '';
      if (!username || !password) return showError('Enter your username/email and password.');
      clearError();
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      var remember = !!(remEl && remEl.checked);
      apiJson('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: username, password: password, remember: remember })
      }).then(function (body) {
        if (!body || !body.user) throw new Error('invalid_login_response');
        enter(body.user);
      }).catch(function (e) {
        if (e && e.status === 429) return showError('Too many attempts. Try again in a few minutes.');
        if (e && e.name === 'AbortError') return showError('The server took too long to respond. Please try again.');
        if (e && e.message === 'invalid_credentials') return showError('Incorrect username/email or password.');
        if (e && e.message === 'invalid_login_response') return showError('The server returned an invalid login response.');
        showError('Login failed. Please try again.');
      });
    }

    /* Show/hide password. The markup's own handler sits in the legacy gate the
       build renames out, so the button is inert unless it is wired here. */
    var eye = document.getElementById('lgEye');
    if (eye && pEl) eye.addEventListener('click', function () {
      var showing = pEl.type === 'text';
      pEl.type = showing ? 'password' : 'text';
      eye.classList.toggle('on', !showing);
      eye.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      try { pEl.focus(); } catch (e) {}
    });

    if (btn) btn.addEventListener('click', submit);
    if (form) form.addEventListener('submit', submit);
    if (pEl) pEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(e); });
    if (uEl) uEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (pEl) pEl.focus(); } });
    if (outBtn) outBtn.addEventListener('click', function () {
      apiJson('/api/logout', { method: 'POST', body: '{}' }).finally(function () { location.reload(); });
    });

    // Ask the server whether a valid session already exists.
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (j) {
        if (j && j.user) enter(j.user);
        else setTimeout(function () { try { if (uEl) uEl.focus(); } catch (e) {} }, 60);
      })
      .catch(function () { setTimeout(function () { try { if (uEl) uEl.focus(); } catch (e) {} }, 60); });
  }

  window.initLoginGate = function (startWorkspace) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setupGate(startWorkspace); }, { once: true });
    } else {
      setupGate(startWorkspace);
    }
  };

  // Safety net: if a legacy script fails before it reaches the normal call at
  // the bottom of index.html, the login form still gets initialized.
  function autoBoot() {
    if (document.getElementById('loginGate') && !window.HWAuth.__booted) {
      window.initLoginGate(function (first) {
        if (typeof window.__HWStartWorkspace === 'function') window.__HWStartWorkspace(first);
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoBoot, { once: true });
  else setTimeout(autoBoot, 0);
})();
