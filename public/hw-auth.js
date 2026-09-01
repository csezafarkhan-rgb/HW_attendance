/* Server-backed login gate.
 *
 * Replaces the old client-side gate, which compared a SHA-256 hash that was
 * embedded in the HTML - anyone could read it or bypass it in devtools. This
 * version holds no credentials at all; the server decides, and the session
 * lives in an HTTP-only cookie the page cannot read.
 *
 * Reuses the existing gate markup so the sign-in screen looks unchanged, but
 * asks for email + password in one step instead of the old two-step flow.
 */
(function () {
  'use strict';

  window.HWAuth = {
    user: null,
    onExpired: function () {
      // Session died mid-session (expired, or signed out elsewhere).
      if (window.HWAuth.__reloading) return;
      window.HWAuth.__reloading = true;
      location.reload();
    }
  };

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  window.initLoginGate = function (startWorkspace) {
    var gate = document.getElementById('loginGate');
    var uEl = document.getElementById('lgUser');
    var pEl = document.getElementById('lgPass');
    var btn = document.getElementById('lgBtn');
    var errEl = document.getElementById('lgErr');
    var who = document.getElementById('whoami');
    var outBtn = document.getElementById('logoutBtn');
    var usersBtn = document.getElementById('usersBtn');
    var pbBtn = document.getElementById('pbBtn');
    var sub = document.getElementById('lgTitleSub');

    // Email + password together; no separate "Continue" step.
    var passField = document.getElementById('lgPassField');
    if (passField) passField.style.display = '';
    var backBtn = document.getElementById('lgBack');
    if (backBtn) backBtn.style.display = 'none';
    var rememberRow = document.getElementById('lgRememberRow');
    if (rememberRow) rememberRow.style.display = 'none'; // cookie handles this now
    if (btn) btn.textContent = 'Sign in';
    if (sub) sub.textContent = 'Sign in with your work email';
    var lbl = document.querySelector('label[for="lgUser"]');
    if (lbl) lbl.textContent = 'Email';
    if (uEl) { uEl.type = 'email'; uEl.setAttribute('autocomplete', 'username'); }

    // Password recovery is an admin action now, not a client-side question.
    ['lgCpLink', 'lgFpLink'].forEach(function (id) {
      var a = document.getElementById(id);
      if (a && id === 'lgFpLink') { a.textContent = 'Forgot password? Ask an admin'; a.removeAttribute('href'); a.style.cursor = 'default'; }
    });

    function fail(msg) {
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    }

    function enter(user) {
      window.HWAuth.user = user;
      if (who) who.textContent = '\uD83D\uDC64 ' + (user.name || user.email) + (user.role === 'admin' ? ' \u00B7 Admin' : '');
      if (outBtn) outBtn.style.display = '';
      // Only admins manage users or take whole-project backups.
      if (usersBtn) usersBtn.style.display = user.role === 'admin' ? '' : 'none';
      if (pbBtn) pbBtn.style.display = user.role === 'admin' ? '' : 'none';

      // Load every shared setting in one request before the dashboard boots,
      // so its ~30 startup reads are served from cache.
      var ready = (window.HWSync && window.HWSync.hydrate) ? window.HWSync.hydrate() : Promise.resolve();
      ready.catch(function () {}).then(function () {
        gate.classList.add('lg-out');
        setTimeout(function () { gate.style.display = 'none'; }, 380);
        startWorkspace('attendance');
        if (window.HWLiveSync) {
          window.HWLiveSync.start(function () {
            // Someone else changed shared data - tell the dashboard to reread.
            var fr = document.querySelector('#frames iframe[data-id="attendance"]');
            if (fr && fr.contentWindow) {
              try { fr.contentWindow.postMessage({ type: 'hw-remote-change' }, '*'); } catch (e) {}
            }
          });
        }
      });
    }

    function submit() {
      var email = (uEl && uEl.value || '').trim();
      var pass = (pEl && pEl.value) || '';
      if (!email || !pass) return fail('Enter your email and password.');
      if (errEl) errEl.style.display = 'none';
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      post('/api/login', { email: email, password: pass }).then(function (r) {
        if (r.status === 200 && r.body && r.body.user) return enter(r.body.user);
        if (r.status === 429) return fail('Too many attempts. Try again in a few minutes.');
        fail('Incorrect email or password.');
      }).catch(function () { fail('Could not reach the server. Check your connection.'); });
    }

    if (btn) btn.addEventListener('click', submit);
    var form = document.getElementById('lgForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    if (pEl) pEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    if (uEl) uEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (pEl) pEl.focus(); } });

    if (outBtn) {
      outBtn.addEventListener('click', function () {
        post('/api/logout').then(function () { location.reload(); });
      });
    }

    // Already signed in? Skip the gate.
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (j) {
        if (j && j.user) enter(j.user);
        else setTimeout(function () { try { uEl.focus(); } catch (e) {} }, 60);
      })
      .catch(function () {});
  };
})();
