// Registers coi-serviceworker.js and reloads the page exactly once so the
// worker can take control and start adding the isolation headers. Must run
// as a plain, blocking (non-module) script that executes BEFORE src/main.js,
// so main.js's isolation check sees the outcome of this, not a stale state.
//
// window.__coiBootstrap.pending tells main.js "isolation isn't active yet,
// but a reload to fix that is already in flight — don't show a hard error."
(function () {
  window.__coiBootstrap = { pending: false };

  if (window.crossOriginIsolated) return;

  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    // Nothing we can do from here — main.js will report this plainly.
    return;
  }

  window.__coiBootstrap.pending = true;

  // Give up waiting after a few seconds so a genuinely stuck case (rather
  // than "reload is about to happen") surfaces main.js's real error text
  // instead of hanging on "enabling isolation…" forever.
  setTimeout(function () {
    window.__coiBootstrap.pending = false;
  }, 4000);

  var RELOAD_KEY = 'coiReloadedBySW';

  navigator.serviceWorker
    .register('coi-serviceworker.js', { scope: './' })
    .then(function (registration) {
      function reloadOnce() {
        if (sessionStorage.getItem(RELOAD_KEY)) return; // already tried once this session
        sessionStorage.setItem(RELOAD_KEY, '1');
        window.location.reload();
      }

      if (registration.active && !navigator.serviceWorker.controller) {
        reloadOnce();
        return;
      }
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
    })
    .catch(function (err) {
      window.__coiBootstrap.pending = false;
      console.warn('coi-serviceworker registration failed:', err);
    });
})();
