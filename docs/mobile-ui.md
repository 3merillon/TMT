# Mobile UI and input

Touch controls use the same session commands as keyboard and gamepad input. The layout shares the game's dark
steel, glass and brass tokens across the title, menus, workshop and match. Graphics, saves and simulation do not
read the selected input style.

## Layout and control ownership

| Context | Layout |
|---|---|
| Portrait phone | Compact top chips, a fixed joystick at bottom left, a matching Fire/Hold pad at bottom right, small action buttons above each pad, and a power rail between them |
| Landscape phone | The same thumb controls and safe-area margins; compact centered menus |
| Tablet | Touch controls after touch input, with centered menus and the desktop workshop layout when space permits |
| Desktop | Compact chips and mouse dock; sliders and full munition selection in the fine-aim drawer |
| Workshop on phones | Build/budget bar, a snapping component sheet, overflow tools and sticky install/discard actions |

`#game[data-input]` follows the latest pointer type. Its initial value comes from `(pointer: coarse)`;
`?touch=1` and `?touch=0` force touch or mouse presentation for inspection. Pointer-style changes do not reload the game.
The tank chip opens match information, roster, objectives and trajectory assistance. Fine aim contains bearing,
elevation, weapon and munition controls; ordinary turn news uses transient toasts.

## Gestures and commands

| Match context | Joystick | Main action | World gestures |
|---|---|---|---|
| Aim | Bearing/elevation rate | Fire | Tap aims at terrain; drag orbits; pinch zooms; dragging from the tank uses drag aim |
| Relocate | Drive/steer | Hold position | Orbit and pinch zoom |
| Drive test | Drive/steer | Fire | Tap aims; orbit and pinch zoom remain available |
| Watch | Hidden | Camera controls | Orbit and pinch zoom |

One arbiter in `src/game/ui/input/gestures.ts`, bound by `input/touch.ts`, owns world gestures. A tap is under
10 pixels of movement and 350 ms. Passing the movement slop orbits; a second finger pinches, and a finger remaining
after a pinch never becomes a tap. DOM controls sit outside the canvas, so pressing one does not begin a world gesture.

The joystick uses pointer capture and releases on pointer lift/cancel, lost capture, blur, page hiding, input clearing
or context changes. Its fixed base reads the thumb against a stable center and keeps the knob inside the rim.
It feeds the existing virtual-stick path, preserving dead-zone and response-curve behavior. Thumb buttons call
`InputController.press`, including the Fire path that flushes pending ground aim. Power is a separate slider.

The mouse uses left-click/drag aim, right-drag orbit and wheel range trim while aiming (zoom otherwise).
Workshop paint accepts mouse/pen strokes; touch gestures orbit instead of painting.

## Camera-relative driving

`src/game/ui/input/camera-drive.ts` projects the stick's screen direction onto the tank's tangent plane using the
camera's right vector. Steering follows the signed hull-to-target angle, reaching full lock at 45°; throttle is stick
deflection times the angle's cosine. A target behind the hull switches to reverse at 105°, returning at 75°, so
small direction changes do not flicker between forward and reverse. Pushing across the hull pivots it.

Gameplay settings default **Touch joystick** to Camera and **Keyboard and gamepad driving** to Tank. Saved fields
are `touchDrive` and `keyDrive`; older profiles receive those defaults. Camera-relative mapping still produces ordinary
`drive` commands, preserving the simulation/replay boundary. A brass heading needle shows the hull's screen direction
in touch camera mode; the DOM is updated only after a half-degree change. The follow camera centers the tank without
a portrait-only projection shift.

## Components, tokens and page behavior

Reusable UI pieces live under `src/game/ui/`:

- `components/joystick.ts`, `input/joystick.ts` and `input/gestures.ts` own stick/gesture behavior.
- `components/sheet.ts` and pure `components/sheet-model.ts` own swipe dismissal and snapping.
- `hud-layout.ts` owns the context-to-controls map, input style and union-area coverage measurement.
- `components/panel.ts` supplies `screenCard({ dismiss })` and `collapsible()`.

`game.css` defines spacing, type, `--touch: 44px`, safe-area insets and the shared surface/line/brass/signal tokens.
`workshop.css` uses the same tokens. Fire uses the ember signal; primary actions use brass. Legacy token names resolve
to the shared palette. Sheets and toasts respect safe areas, form text is 16 pixels on phones, and reduced motion
honors both the OS preference and game setting.

The game fills `100dvh`. Its viewport metadata disables page zoom, the game surface uses `touch-action: none`, and
only explicit scroll containers pan. Buttons use `touch-action: manipulation`; iOS gesture events are canceled.
World pinches control the camera. The joystick and Fire/Hold pads share `--pad: clamp(96px, 26vmin, 124px)`, with
44-pixel action slots above them and a power rail at most 300 pixels wide.

In `?mode=dev`, touch drive, Fire and camera controls remain available even when the ordinary HUD is hidden.
The development panel starts folded on phones and fits below the safe area.

## Recorded validation and limits

The 15 October 2026 desktop Chromium captures used emulated touch. For the fixed-pad layout, portrait aim HUD
coverage was 14.2%, relocate 4.8% (excluding the joystick while Hold replaced Fire), and landscape aim 17.8%.
`window.__tmtGame.hud.coverage()` measures the union of visible HUD pieces; open drawers and transient content must be
reported separately when comparing layouts.

A recorded touch-only turn trimmed aim, changed power from 0.55 to 0.99, acquired a ground target, fired a terrain
edit, drove 8.1 units while a second finger used the camera button, then yielded through Hold. With the camera orbited
away from the hull, a screen-up stick input turned a hull initially 35° off screen-up and drove 13.7 units at 1° from
screen-up. A hull initially 115° off backed out in an arc. These establish input behavior in that desktop setup;
they do not qualify physical-phone GPU performance.

The local-only capture sets were named `run2`, `design1`, `design2`, `pads1` and `camdrive2`; they are not shipped.
The shared `scripts/capture.ts` supports real CDP touch via `--touch`, `tap`, `swipe`, `pinch` and `stick` steps.
`tests/ui-touch.test.ts` covers gesture/stick math, context maps, coverage and sheet snapping;
`tests/ui-camera-drive.test.ts` covers camera-relative mapping.

The recorded native rules run passed 306 tests. The contemporaneous full suite had five failures under concurrent
load; isolated reruns resolved three files, while the slow kit-interference suite still exceeded its 30-second limit.
This is historical validation, not a fresh full-suite pass. Current checks, bundle results and device qualification
are recorded in [release readiness](release-readiness.md).
