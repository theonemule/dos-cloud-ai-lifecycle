# Mobile touch controls (Phase 6 runtime)

The game runtime automatically shows a thumb-oriented control layout on phone/tablet browsers. Desktop mouse-and-keyboard sessions stay unchanged. The runtime header has an explicit **Touch controls** toggle for overrides; an override persists in localStorage key `doscloud.touchControls` (`on`/`off`), while an unset key uses automatic detection.

## Layout and key mapping

- Left thumb: directional pad (up, down, left, right).
- Right thumb: Ctrl, Alt, Space.
- Secondary row: Esc, Enter, Tab.
- Portrait: game on top, controls beneath. Landscape: D-pad to left of game, actions to right. Buttons avoid covering the canvas and respect the bottom safe area.

Input reaches the js-dos command interface through `ci.sendKeyEvent(code, pressed)`, not fabricated browser `KeyboardEvent` objects. Multiple pointers can hold different keys simultaneously (e.g. Ctrl+Up); multiple touches on one button are reference-counted. D-pad dragging swaps the held direction. Buttons release on pointerup, pointercancel, lost pointer capture, page visibility loss, navigation, blur, UI hide, and emulator exit, preventing stuck keys.

Automatic detection combines touch support, primary coarse pointer, viewport width, and the mobile user-agent hint. A desktop touch laptop with a fine primary pointer doesn't automatically enter phone mode. The header toggle lets users override any detection error.

## Validation

Run `npm test` in `phase-06-change-ipx-multiplayer` to execute `test/mobile-controls.test.js` alongside existing Node regression tests. Manual browser checks should cover:

1. iPhone/Android portrait and landscape, including rotate while holding a button.
2. Hold an arrow and Ctrl/Alt/Space at the same time; release each independently.
3. Slide a held finger between D-pad directions, lift off, and check no stuck key.
4. Return to the page, switch tabs, or suspend the app mid-press; keys release.
5. Desktop keyboard/mouse mode, touchscreen laptop, and explicit show/hide toggle.
6. Enter and Esc in game menus; multiplayer sessions using the same runtime.

Individual DOS games may require additional keys, mouse input, or game-specific layouts. This intentionally provides only the common universal keyboard controls without changing game manifests, emulator settings, network services, or desktop key handling.
