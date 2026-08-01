(() => {
  /* ---------- synthetic test cursor -------------------------------------
   * Playwright never moves the OS cursor: it synthesizes input straight into
   * the renderer and teleports to the element centre. So the pointer the user
   * watches during a Watch-in-Dyad run is drawn here.
   *
   * It lives in the guest page rather than over Dyad's canvas so it renders in
   * the page's own compositor -- which means it survives both the screencast
   * and a possible future native view.
   *
   * It is presentation only. It must never dispatch an event: the page received
   * one jump, and interpolating real moves along the drawn path would fire
   * hover handlers that a headless run never fires.
   * -------------------------------------------------------------------- */

  const HOST_ID = "dyad-test-cursor-host";
  const MIN_TRAVEL_MS = 90;
  const MAX_TRAVEL_MS = 320;

  let host = null;
  let root = null;
  let cursorEl = null;
  let labelEl = null;
  let rippleEl = null;
  let trailEl = null;
  let current = { x: 0, y: 0 };
  let animation = null;

  function ensureMounted() {
    if (host && host.isConnected) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-dyad-ignore", "true");
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";

    // Closed so the app under test cannot reach in and so querySelector-based
    // assertions in the user's own specs never see these nodes.
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .trail {
          position: fixed; height: 2px; transform-origin: 0 50%;
          background: linear-gradient(90deg, rgba(20,184,166,0) 0%, rgba(20,184,166,.55) 100%);
          opacity: 0; transition: opacity .18s ease-out; pointer-events: none;
        }
        .cursor {
          position: fixed; width: 20px; height: 20px; margin: -2px 0 0 -2px;
          pointer-events: none; will-change: transform;
        }
        .cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
        .ripple {
          position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px;
          border-radius: 50%; border: 2px solid rgba(20,184,166,.9);
          opacity: 0; pointer-events: none;
        }
        .ripple.fire { animation: dyad-ripple .42s ease-out; }
        @keyframes dyad-ripple {
          from { opacity: .95; transform: scale(.35); }
          to   { opacity: 0;   transform: scale(2.6); }
        }
        .label {
          position: fixed; margin: 18px 0 0 16px; padding: 3px 7px;
          font: 500 11px/1.35 ui-sans-serif, system-ui, sans-serif;
          color: #fff; background: rgba(13,148,136,.95); border-radius: 5px;
          white-space: nowrap; pointer-events: none; opacity: 0;
          transition: opacity .15s ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .ripple.fire { animation-duration: .01ms; }
        }
      </style>
      <div class="trail"></div>
      <div class="ripple"></div>
      <div class="cursor">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M3 2l12 6.2-5.1 1.4L8.5 15z" fill="#0d9488" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="label"></div>
    `;

    trailEl = root.querySelector(".trail");
    rippleEl = root.querySelector(".ripple");
    cursorEl = root.querySelector(".cursor");
    labelEl = root.querySelector(".label");
    document.documentElement.appendChild(host);
    place(current);
  }

  function place(point) {
    if (!cursorEl) return;
    const transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    cursorEl.style.transform = transform;
    labelEl.style.transform = transform;
    rippleEl.style.transform = transform;
  }

  function easeOutCubic(t) {
    const clamped = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - clamped, 3);
  }

  function drawTrail(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 24) {
      trailEl.style.opacity = "0";
      return;
    }
    trailEl.style.width = `${length}px`;
    trailEl.style.opacity = "1";
    trailEl.style.transform = `translate3d(${from.x}px, ${from.y}px, 0) rotate(${Math.atan2(dy, dx)}rad)`;
    setTimeout(() => {
      if (trailEl) trailEl.style.opacity = "0";
    }, 180);
  }

  function moveTo(target, label) {
    ensureMounted();
    if (animation) cancelAnimationFrame(animation);

    const from = { ...current };
    const distance = Math.hypot(target.x - from.x, target.y - from.y);
    const duration = Math.min(
      MAX_TRAVEL_MS,
      Math.max(MIN_TRAVEL_MS, MIN_TRAVEL_MS + distance * 0.35),
    );

    if (label) {
      labelEl.textContent = label;
      labelEl.style.opacity = "1";
    } else {
      labelEl.style.opacity = "0";
    }

    drawTrail(from, target);

    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = easeOutCubic(t);
      current = {
        x: from.x + (target.x - from.x) * eased,
        y: from.y + (target.y - from.y) * eased,
      };
      place(current);
      if (t < 1) animation = requestAnimationFrame(step);
      else animation = null;
    };
    animation = requestAnimationFrame(step);
  }

  function click() {
    if (!rippleEl) return;
    rippleEl.classList.remove("fire");
    // Reflow so the animation restarts on a repeated click at the same point.
    void rippleEl.offsetWidth;
    rippleEl.classList.add("fire");
  }

  /**
   * Removed from the DOM entirely rather than hidden: the page is about to be
   * captured by the user's own toHaveScreenshot(), and an invisible-but-present
   * node still changes the layout the assertion sees.
   */
  function teardown() {
    if (animation) cancelAnimationFrame(animation);
    animation = null;
    if (host && host.isConnected) host.remove();
    host = root = cursorEl = labelEl = rippleEl = trailEl = null;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data.type !== "string") return;

    switch (data.type) {
      case "dyad-test-cursor-move":
        if (typeof data.x === "number" && typeof data.y === "number") {
          moveTo({ x: data.x, y: data.y }, data.label);
        }
        break;
      case "dyad-test-cursor-click":
        click();
        break;
      case "dyad-test-cursor-hide":
      case "dyad-test-cursor-teardown":
        teardown();
        break;
    }
  });
})();
