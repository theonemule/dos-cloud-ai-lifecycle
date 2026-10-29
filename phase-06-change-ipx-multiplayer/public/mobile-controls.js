/* Mobile DOS keyboard controls: pointer events -> js-dos command interface.
 * Kept independent of the emulator worker so each key supports hold/release.
 */
(function (scope) {
  "use strict";

  const KEY_CODES = Object.freeze({
    up: 265, down: 264, left: 263, right: 262,
    ctrl: 341, alt: 342, space: 32,
    esc: 256, enter: 257, tab: 258
  });

  function isMobileTouchClient(env) {
    const nav = env.navigator || {};
    const coarse = Boolean(env.matchMedia && env.matchMedia("(pointer: coarse)").matches);
    const touch = Number(nav.maxTouchPoints || 0) > 0 || coarse;
    const mobileUA = Boolean(nav.userAgentData && nav.userAgentData.mobile) ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || "");
    const width = Number(env.visualViewport && env.visualViewport.width) ||
      Number(env.innerWidth) || 2000;
    // Touchscreen laptops with a fine primary pointer remain in desktop mode.
    return touch && (mobileUA || (coarse && width <= 1024));
  }

  function createKeyDispatcher(getInterface) {
    const pointers = new Map(); // pointer ID -> key
    const held = new Map(); // key -> number of fingers holding it

    function press(pointerId, key) {
      const code = KEY_CODES[key];
      const ci = getInterface();
      if (code === undefined || !ci || typeof ci.sendKeyEvent !== "function" ||
          pointers.has(pointerId)) return false;
      const count = held.get(key) || 0;
      if (count === 0) ci.sendKeyEvent(code, true);
      held.set(key, count + 1);
      pointers.set(pointerId, key);
      return true;
    }

    function release(pointerId) {
      const key = pointers.get(pointerId);
      if (!key) return false;
      pointers.delete(pointerId);
      const count = held.get(key) || 0;
      if (count <= 1) {
        held.delete(key);
        const ci = getInterface();
        if (ci && typeof ci.sendKeyEvent === "function") {
          ci.sendKeyEvent(KEY_CODES[key], false);
        }
      } else {
        held.set(key, count - 1);
      }
      return true;
    }

    function releaseAll() {
      for (const id of [...pointers.keys()]) release(id);
    }

    return {
      press, release, releaseAll,
      move(pointerId, key) {
        if (pointers.get(pointerId) === key) return;
        release(pointerId);
        press(pointerId, key);
      },
      isHeld(key) { return held.has(key); },
      activeCount() { return pointers.size; }
    };
  }

  function attach({ panel, stage, toggle }) {
    if (!panel || !stage || !toggle) throw new Error("Mobile gamepad elements missing");
    const doc = scope.document;
    let ci = null;
    const keys = createKeyDispatcher(() => ci);
    let preference = "auto";
    try {
      const stored = scope.localStorage.getItem("doscloud.touchControls");
      if (stored === "on" || stored === "off") preference = stored;
    } catch (_) { /* storage can be unavailable in private browsing */ }

    const buttons = Array.from(panel.querySelectorAll("button[data-key]"));
    const syncPressed = () => buttons.forEach(button =>
      button.classList.toggle("is-down", keys.isHeld(button.dataset.key)));

    function applyVisibility() {
      const enabled = preference === "on" ||
        (preference === "auto" && isMobileTouchClient(scope));
      if (!enabled) {
        keys.releaseAll();
        syncPressed();
      }
      panel.hidden = !enabled;
      stage.classList.toggle("touch-active", enabled);
      toggle.setAttribute("aria-pressed", String(enabled));
      toggle.textContent = enabled ? "Touch controls: On" : "Touch controls: Off";
      toggle.title = preference === "auto"
        ? "Auto-detected touch controls. Tap to override."
        : "Touch controls manually " + preference + ". Tap to change.";
    }

    toggle.addEventListener("click", () => {
      // First tap turns off an auto-enabled phone or enables an auto-disabled PC.
      const enabled = !panel.hidden;
      preference = enabled ? "off" : "on";
      try { scope.localStorage.setItem("doscloud.touchControls", preference); }
      catch (_) { /* still works for this session */ }
      applyVisibility();
    });

    for (const button of buttons) {
      button.addEventListener("pointerdown", event => {
        if (panel.hidden || (event.pointerType === "mouse" && event.button !== 0)) return;
        event.preventDefault();
        if (!keys.press(event.pointerId, button.dataset.key)) return;
        try { button.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
        syncPressed();
      });

      // Sliding a thumb around the D-pad changes held directions without lifting.
      button.addEventListener("pointermove", event => {
        if (!button.hasPointerCapture || !button.hasPointerCapture(event.pointerId) ||
            !button.closest(".touch-dpad")) return;
        const target = doc.elementFromPoint(event.clientX, event.clientY);
        const next = target && target.closest("button[data-key]");
        if (next && next.closest(".touch-dpad") === button.closest(".touch-dpad")) {
          keys.move(event.pointerId, next.dataset.key);
          syncPressed();
        }
      });

      const end = event => {
        keys.release(event.pointerId);
        syncPressed();
      };
      button.addEventListener("pointerup", end);
      button.addEventListener("pointercancel", end);
      button.addEventListener("lostpointercapture", end);
      button.addEventListener("contextmenu", event => event.preventDefault());
      button.addEventListener("click", event => {
        // Allow keyboard and assistive-technology activation as a discrete tap.
        if (event.detail !== 0 || panel.hidden || !ci) return;
        if (typeof ci.simulateKeyPress === "function") {
          ci.simulateKeyPress(KEY_CODES[button.dataset.key]);
        }
      });
    }

    scope.addEventListener("resize", applyVisibility);
    scope.addEventListener("blur", () => { keys.releaseAll(); syncPressed(); });
    scope.addEventListener("pagehide", () => { keys.releaseAll(); syncPressed(); });
    doc.addEventListener("visibilitychange", () => {
      if (doc.hidden) { keys.releaseAll(); syncPressed(); }
    });
    if (scope.visualViewport) scope.visualViewport.addEventListener("resize", applyVisibility);
    applyVisibility();

    return {
      setCommandInterface(next) {
        keys.releaseAll();
        ci = next;
        syncPressed();
      },
      releaseAll() { keys.releaseAll(); syncPressed(); },
      resetToAuto() {
        preference = "auto";
        try { scope.localStorage.removeItem("doscloud.touchControls"); } catch (_) {}
        applyVisibility();
      }
    };
  }

  const api = { KEY_CODES, isMobileTouchClient, createKeyDispatcher, attach };
  scope.DosCloudTouchControls = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
