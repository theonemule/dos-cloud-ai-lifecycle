"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { KEY_CODES, isMobileTouchClient, createKeyDispatcher } = require("../public/mobile-controls.js");

function device({ width = 800, touch = 5, coarse = true, ua = "Mozilla/5.0 (Linux; Android 15; Mobile)", mobile = false } = {}) {
  return {
    innerWidth: width,
    navigator: { maxTouchPoints: touch, userAgent: ua, userAgentData: { mobile } },
    matchMedia: query => ({ matches: query === "(pointer: coarse)" ? coarse : false })
  };
}

test("detects mobile touch browsers in both orientations", () => {
  assert.equal(isMobileTouchClient(device({ width: 390 })), true);
  assert.equal(isMobileTouchClient(device({ width: 850 })), true);
  assert.equal(isMobileTouchClient(device({ width: 1030, mobile: true })), true);
});

test("does not force touch controls onto desktop mouse or touch laptops", () => {
  assert.equal(isMobileTouchClient(device({ touch: 0, coarse: false, ua: "Desktop", width: 390 })), false);
  assert.equal(isMobileTouchClient(device({ touch: 10, coarse: false, ua: "Desktop", width: 800 })), false);
  assert.equal(isMobileTouchClient(device({ touch: 10, coarse: true, ua: "Desktop", width: 1440 })), false);
  assert.equal(isMobileTouchClient(device({ touch: 10, coarse: true, ua: "iPad", width: 900 })), true);
});

test("sends held keys and multi-touch combinations, then releases in order", () => {
  const events = [];
  const ci = { sendKeyEvent(code, pressed) { events.push([code, pressed]); } };
  const keys = createKeyDispatcher(() => ci);
  assert.equal(keys.press(1, "up"), true);
  assert.equal(keys.press(2, "ctrl"), true);
  assert.equal(keys.press(3, "space"), true);
  keys.release(2);
  keys.release(1);
  keys.release(3);
  assert.deepEqual(events, [
    [KEY_CODES.up, true], [KEY_CODES.ctrl, true], [KEY_CODES.space, true],
    [KEY_CODES.ctrl, false], [KEY_CODES.up, false], [KEY_CODES.space, false]
  ]);
  assert.equal(keys.activeCount(), 0);
});

test("reference-counts two simultaneous fingers on the same key", () => {
  const events = [];
  const keys = createKeyDispatcher(() => ({
    sendKeyEvent(code, pressed) { events.push([code, pressed]); }
  }));
  keys.press(1, "left");
  keys.press(2, "left");
  keys.release(1);
  assert.equal(keys.isHeld("left"), true);
  keys.release(2);
  assert.deepEqual(events, [[KEY_CODES.left, true], [KEY_CODES.left, false]]);
});

test("sliding across a D-pad changes direction and releases canceled touches", () => {
  const events = [];
  const ci = { sendKeyEvent(code, pressed) { events.push([code, pressed]); } };
  const keys = createKeyDispatcher(() => ci);
  keys.press(7, "up");
  keys.move(7, "right");
  keys.move(7, "right");
  keys.releaseAll();
  keys.release(7); // lost capture and pointerup must be idempotent
  assert.deepEqual(events, [
    [KEY_CODES.up, true], [KEY_CODES.up, false],
    [KEY_CODES.right, true], [KEY_CODES.right, false]
  ]);
  assert.equal(keys.activeCount(), 0);
});

test("never consumes inputs until the emulator command interface exists", () => {
  let ci = null;
  const events = [];
  const keys = createKeyDispatcher(() => ci);
  assert.equal(keys.press(1, "alt"), false);
  ci = { sendKeyEvent(code, pressed) { events.push([code, pressed]); } };
  keys.press(1, "alt");
  keys.releaseAll();
  assert.deepEqual(events, [[KEY_CODES.alt, true], [KEY_CODES.alt, false]]);
});
