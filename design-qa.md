# Design QA — Floating Studio

Date: 2026-07-15

## Evidence

- Visual source: 用户提供的产品参考截图（本地临时文件，不纳入分享包）
- Implemented desktop state: `artifacts/design-qa-current.png`
- Implemented narrow-window state: `artifacts/design-qa-980x720.png`
- Desktop viewport/state: 2048×1080, blank Excalidraw canvas, workbench closed, teleprompter open, camera monitor active, idle recording.
- Narrow viewport/state: 980×720 with the same controls and media state.
- Comparison method: the source and implemented desktop capture were inspected together at original resolution; the narrow capture was inspected after the responsive fix.

## Visual and interaction review

- Layout: the reference's light floating surfaces, rounded corners, restrained border, shadow hierarchy, red record action and purple active state are preserved. The current recorder dock stays at the upper right on desktop; the movable teleprompter defaults to the upper center so the speaker can read closer to the camera.
- Intentional deviation: the reference teleprompter is fixed at the right. The current product makes it draggable, resizable and minimizable because the user explicitly requested control over eye-line. It remains an operator-only overlay and does not enter the recording compositor.
- Desktop resilience: recorder dock, Excalidraw toolbar, teleprompter, camera monitor, zoom controls and help control do not collide at 2048×1080.
- Narrow-window resilience: the first 980×720 pass exposed a recorder dock stretched between `top` and `bottom`. The final responsive override resets `top: auto`; the post-fix capture shows a compact bottom-center dock, status above it, camera at bottom right and no control-to-control collision.
- Typography and spacing: Chinese labels remain readable, hierarchy is clear, controls keep practical target sizes, and long status text truncates in its own pill instead of changing dock height.
- Color and surfaces: neutral white surfaces, purple active controls, red primary recording action, green readiness dot and subtle translucent shadows are consistent across dock, workbench and teleprompter.
- States and behavior: workbench open/close, teleprompter open/close/drag/resize/reopen, camera on/off, microphone toggle, recording start/stop, automatic zoom and recording review are exercised by automated smoke tests.
- Accessibility: custom buttons use semantic button elements, toggles expose `aria-pressed`, dialogs/panels have labels, keyboard focus has a visible outline, and reduced-motion styles disable nonessential transitions.
- Asset fidelity: Excalidraw's real toolbar and icon assets are used; no substitute CSS illustration or placeholder icon was introduced.

## Functional evidence attached to QA

- Laser strokes visibly add red trajectory pixels to the output while the camera is locked, then produce approximately 1.4× automatic zoom when enabled.
- Selection gestures remain at 1.0× and do not trigger camera movement.
- The output compositor receives camera frames, and the recorded MP4 contains both a 1280×720 video stream and an audio stream.
- The camera monitor is removed after recording stops.
- Teleprompter changes do not alter output pixels and its geometry persists after close/reopen.

## Remaining scope, not a failed QA item

- This is a Windows-oriented desktop Web MVP; phone layout and native installer chrome are outside this phase.
- Real camera/microphone hardware, 20–30 minute sessions and Tauri packaging remain the next acceptance phase.

final result: passed
