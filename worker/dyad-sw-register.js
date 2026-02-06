/**
 * dyad-sw-register.js – Service Worker registration script
 * This script is injected into the HTML to register the Service Worker
 * and forward messages to the parent window.
 *
 * It also prevents user-defined service workers from registering, which
 * would conflict with Dyad's SW and cause constant re-renders / ECONNABORTED
 * proxy errors (see https://github.com/dyad-sh/dyad/issues/2320).
 */

(function () {
  // Check if Service Workers are supported
  if (!("serviceWorker" in navigator)) {
    console.warn("[Dyad] Service Workers are not supported in this browser");
    return;
  }

  var DYAD_SW_URL = "/dyad-sw.js";

  // Save a reference to the original register method before overriding
  var originalRegister = navigator.serviceWorker.register.bind(
    navigator.serviceWorker,
  );

  // Override navigator.serviceWorker.register to block non-Dyad service workers.
  // User apps (e.g. PWAs) may try to register their own SWs which would conflict
  // with Dyad's SW at the same scope, causing re-render loops.
  navigator.serviceWorker.register = function (scriptURL, options) {
    var resolvedURL;
    try {
      resolvedURL = new URL(scriptURL, location.href).pathname;
    } catch {
      resolvedURL = scriptURL;
    }

    if (resolvedURL === DYAD_SW_URL) {
      // Allow Dyad's own SW registration
      return originalRegister(scriptURL, options);
    }

    console.warn(
      "[Dyad] Blocked service worker registration for: " +
        scriptURL +
        " – only Dyad's service worker is allowed in the preview. " +
        "See https://github.com/dyad-sh/dyad/issues/2320",
    );
    // Return a never-settling promise so callers don't crash on .then()
    // but the SW never actually registers
    return Promise.resolve(
      /** @type {any} */ ({
        scope: (options && options.scope) || "/",
        installing: null,
        waiting: null,
        active: null,
        addEventListener: function () {},
        removeEventListener: function () {},
        unregister: function () {
          return Promise.resolve(true);
        },
        update: function () {
          return Promise.resolve();
        },
      }),
    );
  };

  // Unregister any pre-existing non-Dyad service workers that may have been
  // cached from previous page loads (e.g. user's PWA SW from a prior session).
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    registrations.forEach(function (registration) {
      var swURL = "";
      if (registration.active) {
        swURL = registration.active.scriptURL;
      } else if (registration.installing) {
        swURL = registration.installing.scriptURL;
      } else if (registration.waiting) {
        swURL = registration.waiting.scriptURL;
      }

      try {
        var pathname = new URL(swURL).pathname;
        if (pathname !== DYAD_SW_URL) {
          registration.unregister().then(function (success) {
            if (success) {
              console.log(
                "[Dyad] Unregistered conflicting service worker: " + swURL,
              );
            }
          });
        }
      } catch {
        // If we can't parse the URL, unregister it to be safe
        registration.unregister();
      }
    });
  });

  // Register Dyad's Service Worker using the original (non-overridden) method
  originalRegister(DYAD_SW_URL, { scope: "/" })
    .then(function (registration) {
      console.log("[Dyad] Service Worker registered:", registration.scope);

      // Handle updates
      registration.addEventListener("updatefound", function () {
        console.log("[Dyad] Service Worker update found");
      });
    })
    .catch(function (error) {
      console.error("[Dyad] Service Worker registration failed:", error);
    });

  // Listen for messages from the Service Worker
  navigator.serviceWorker.addEventListener("message", function (event) {
    // Forward all messages to the parent window
    try {
      window.parent.postMessage(event.data, "*");
    } catch (e) {
      console.error("[Dyad] Failed to forward message to parent:", e);
    }
  });

  // Also listen for messages from the active Service Worker controller
  if (navigator.serviceWorker.controller) {
    console.log("[Dyad] Service Worker controller already active");
  }
})();
