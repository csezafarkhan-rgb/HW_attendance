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

  /* This browser's copies of attendance data (see __hwClearLocalData in the
     shell). Resolves either way - clearing is best effort, never a blocker. */
  function clearLocalData() {
    try {
      if (typeof window.__hwClearLocalData === 'function') {
        return Promise.resolve(window.__hwClearLocalData()).catch(function () {});
      }
    } catch (e) {}
    return Promise.resolve();
  }
  var LAST_USER_KEY = 'hwLastUserId';
  /* One sign-out for the top bar and for a dashboard asking: end the server
     session, drop this browser's copies of the data, then start again. */
  window.HWAuth.signOut = function () {
    if (window.HWAuth.__reloading) return;
    window.HWAuth.__reloading = true;
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      .catch(function () {})
      .then(clearLocalData)
      .then(function () {
        try { localStorage.removeItem(LAST_USER_KEY); } catch (e) {}
        location.reload();
      });
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

    /* Two-step sign-in: after a right password on an account that has it on,
       the same card asks for the code from the authenticator app. */
    var codeField = document.getElementById('lgCode') ? document.getElementById('lgCodeField') : null;
    var codeEl = document.getElementById('lgCode');
    var userField = uEl ? uEl.closest('.lg-field') : null;
    var codeMode = false;
    function idleLabel() { return codeMode ? 'Verify' : 'Sign in'; }
    function setCodeMode(on) {
      codeMode = !!on;
      if (userField) userField.style.display = on ? 'none' : '';
      if (passField) passField.style.display = on ? 'none' : '';
      if (rememberRow) rememberRow.style.display = on ? 'none' : '';
      if (codeField) codeField.style.display = on ? '' : 'none';
      if (backBtn) { backBtn.style.display = on ? '' : 'none'; if (on) backBtn.textContent = '← Start again'; }
      if (sub) sub.textContent = on ? 'Enter the 6-digit code from your authenticator app, or one of your recovery codes'
                                    : 'Sign in to open your dashboards';
      if (btn) { btn.disabled = false; btn.textContent = idleLabel(); }
      if (codeEl) codeEl.value = '';
      if (on) { if (pEl) pEl.value = ''; setTimeout(function () { try { codeEl.focus(); } catch (e) {} }, 60); }
    }
    if (backBtn) backBtn.addEventListener('click', function () {
      if (!codeMode) return;
      clearError(); setCodeMode(false);
      try { uEl.focus(); } catch (e) {}
    });

    function showError(message) {
      if (errEl) { errEl.textContent = message; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = idleLabel(); }
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
      /* A view admin cannot manage accounts, but can still protect their own
         sign-in: the same button opens just the "Your sign-in" section. */
      if (usersBtn) {
        usersBtn.style.display = (user.role === 'admin' || user.role === 'admin_view') ? '' : 'none';
        if (user.role === 'admin_view') { usersBtn.textContent = '🔐 Sign-in'; usersBtn.title = 'Two-step sign-in for your account'; }
      }
      if (pbBtn) pbBtn.style.display = user.role === 'admin' ? '' : 'none';

      var ready = (window.HWSync && typeof window.HWSync.hydrate === 'function')
        ? window.HWSync.hydrate()
        : Promise.resolve();
      /* Someone else signed in on this browser last: their copies go before
         the dashboard is built, so nothing of theirs is seeded into this one. */
      var prev = null;
      try { prev = localStorage.getItem(LAST_USER_KEY); } catch (e) {}
      var clean = (prev && prev !== String(user.id)) ? clearLocalData() : Promise.resolve();
      try { localStorage.setItem(LAST_USER_KEY, String(user.id)); } catch (e) {}
      Promise.all([Promise.resolve(ready).catch(function () {}), clean]).then(function () {
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
    function submitCode() {
      var code = ((codeEl && codeEl.value) || '').trim();
      if (!code) return showError('Enter the code from your authenticator app.');
      clearError();
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      apiJson('/api/login/two-step', { method: 'POST', body: JSON.stringify({ code: code }) })
        .then(function (body) {
          if (!body || !body.user) throw new Error('invalid_login_response');
          var left = body.recoveryLeft;
          codeMode = false;
          enter(body.user);
          if (typeof left === 'number') {
            setTimeout(function () {
              alert('You signed in with a recovery code. That code will not work again - ' + left +
                    ' left.' + (left <= 3 ? ' Turn two-step sign-in off and on again (Users, or Sign-in for a view admin) to get new codes.' : ''));
            }, 900);
          }
        })
        .catch(function (e) {
          if (e && e.message === 'two_step_locked') return showError('Too many wrong codes on this account. Two-step sign-in is locked for 15 minutes.');
          if (e && e.status === 429) return showError('Too many attempts. Try again in a few minutes.');
          if (e && e.message === 'two_step_expired') { setCodeMode(false); return showError('That took too long, or too many codes were wrong. Sign in again.'); }
          if (e && e.message === 'invalid_code') { if (codeEl) { codeEl.value = ''; try { codeEl.focus(); } catch (_) {} } return showError('That code is not right. Codes change every 30 seconds - use the one showing now.'); }
          showError('Could not check the code. Please try again.');
        });
    }
    function submit(ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (btn && btn.disabled) return;
      if (codeMode) return submitCode();
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
        if (body && body.twoStep) return setCodeMode(true);
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
    if (codeEl) codeEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(e); });
    if (uEl) uEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (pEl) pEl.focus(); } });
    if (outBtn) outBtn.addEventListener('click', function () { window.HWAuth.signOut(); });

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
