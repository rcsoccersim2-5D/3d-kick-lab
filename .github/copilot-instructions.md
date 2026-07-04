# 3D Kick Lab — Copilot Instructions

## TL;DR
3D Kick Lab is a standalone, browser-based, framework-free (vanilla JS + Three.js) physics sandbox for prototyping a **3D ball-flight extension** to [rcssserver](../../rcssserver) (RoboCup Soccer Simulation 2D server). It is NOT part of rcssserver's build — it's a sibling directory under `D:\workspace\robo\ss2d` used to visually experiment with kick power/direction/loft, gravity, and bounce before porting any formula back into rcssserver's C++ (`object.cpp`/`player.cpp`).

- Entry point: open [index.html](../index.html) directly in a browser (double-click, or `py -m http.server 8000` and browse to it). No build step, no `npm install`, no bundler.
- Core physics engine: [physics.js](../physics.js) — pure, dependency-free, dual-exported for both browser (`window.KickLabPhysics`) and Node (`module.exports`, used by `debug_trace.js`).
- Rendering/UI: [main.js](../main.js) (Three.js scene, playback controls, parameter sliders) + [index.html](../index.html) (markup) + [style.css](../style.css) (dark theme).
- Headless debug tool: [debug_trace.js](../debug_trace.js) — run physics traces from the CLI without a browser, writes CSV-style logs to `logs/` (gitignored).

## Architecture
```
physics.js  ──(window.KickLabPhysics)──>  main.js  ──renders──>  Three.js scene (index.html canvas)
   │                                         │
   └──(module.exports)──> debug_trace.js ────┘ (both consume the SAME engine, no duplication)
```
- **`physics.js`** owns all simulation state and rules: `class KickLabPhysics` with `reset()`, `kick(power, dirDeg, loftDeg)`, `step()`, `isBallKickable()`, `speed()`. It has **zero DOM/Three.js dependencies** — this is intentional so it can run identically in the browser and in Node (`debug_trace.js`) for fast, visual-free regression checks.
- **`main.js`** is the only file that touches Three.js/DOM. It builds the scene (field, goals, player cylinder, ball sphere, trail), wires every UI control (sliders, buttons, coordinate overlays), and drives the `KickLabPhysics` instance frame-by-frame via `requestAnimationFrame`.
- **Coordinate convention**: physics space is `(x, y, z)` where `x,y` = ground plane (matching rcssserver's field coords) and `z` = height (up). Three.js is Y-up, so every physics→render conversion goes through `physToThree(p) => new THREE.Vector3(p.x, p.z, p.y)`. Never construct a `THREE.Vector3` directly from a physics point without this mapping.
- **Player is always fixed at the origin** `(0,0)`, facing `+X` (rcssserver body-angle convention: 0° = facing +X). Only the ball moves in the simulation.
- **Field/goal dimensions mirror rcssserver's real `ServerParam` values**: pitch `105 x 68`, goals at `x = ±52.5` (i.e. `PITCH_LENGTH/2`), goal width `7.32`, goal height `2.44`. If rcssserver's `serverparam.cpp` constants ever change, update `main.js`'s `fieldW/fieldH/GOAL_X/GOAL_WIDTH/GOAL_HEIGHT` to match.

## Critical Convention: Per-Cycle Integration (NOT real-world SI units)
`physics.js`'s `step()` integrates **per cycle**, exactly like rcssserver's `MPObject::_inc()` (`pos += vel`, `vel *= decay` — no `dt` multiplication inside the physics itself). `dt` (default `0.1`) is metadata used only by `main.js` for *playback pacing* (how many sim cycles to advance per wall-clock second), never inside `kick()`/`step()`'s velocity or position math.

**Do not reintroduce `dt` multiplication into the integrator.** A previous bug did exactly this (double-scaling kick velocities that were already per-cycle-scale, combined with real-world `gravity=9.8`), causing high-loft kicks to barely leave the ground. If you touch `step()`, always sanity-check with `debug_trace.js` (see Build & Test) — a `loft=60` kick with `power=100` should reach several meters of peak height over ~5-10 cycles, not stay near 0.

## Patterns & Conventions
- **No framework, no bundler, no `node_modules` at runtime.** Three.js r128 and OrbitControls are loaded via CDN `<script>` tags in `index.html` (cdnjs / jsdelivr). Node is used ONLY for `debug_trace.js` and `node --check` syntax validation — never assume a browser-only file can `require()`.
- **Dual export guard** at the bottom of `physics.js` — any new export must go through both branches:
  ```js
  if (typeof window !== "undefined") { window.KickLabPhysics = KickLabPhysics; window.DEFAULT_PARAMS = DEFAULT_PARAMS; }
  if (typeof module !== "undefined" && module.exports) { module.exports = { KickLabPhysics, DEFAULT_PARAMS }; }
  ```
- **Every tunable constant lives in `DEFAULT_PARAMS`** (physics.js) — never hardcode a magic number for a physics constant in `main.js`; add it to `DEFAULT_PARAMS`, wire a slider via the `PARAM_RANGES` dynamic-slider loop in `main.js`, and add an entry to the `DESCRIPTIONS` map so the "!" info button explains it.
- **Every slider gets an info (`!`) button and a reset (`↺`) button** via `attachInfoButton(rowEl, key, defaultValue)` in `main.js`. When adding a new physics parameter or kick-command slider, follow this exact pattern (see `PARAM_RANGES.forEach(...)` and the `row_power`/`row_dir`/`row_loft` calls) rather than wiring a bare `<input type=range>`.
- **Rendering objects added on top of the ground (trail, markers) must set `depthTest:false` and a high `renderOrder`** to avoid z-fighting with the field/grid meshes (both sit at `y≈0`). See the trail setup in `main.js` for the pattern (`TRAIL_LIFT`, `trailMat`, `trailPointsMat`).
- **DOM-overlay labels, not Three.js sprites**, are used for coordinate readouts (mouse-hover, ball position, axis ticks) — positioned via `worldToScreen()` (`vec3.clone().project(camera)`). Follow this pattern for any new on-screen text overlay; it stays crisp at any zoom level, unlike sprite-based text.

## Key Abstractions
- **`KickLabPhysics`** (`physics.js`) — the whole simulation. Key methods: `reset(overrides)` (re-initializes ball at `init_x/y/z/vx/vy/vz`, player fixed at origin), `kick(power, dirDeg, loftDeg)` (ports rcssserver's `eff_power` formula, splits into horizontal/vertical components via the loft angle, applies `loft_power_cost` penalty), `step()` (gravity, position integration, ground bounce w/ `ball_bounce_restitution`, ground/air xy-decay split via `ball_decay`/`air_decay`), `isBallKickable()` (2D circle test AND `pos.z <= player_reach_height` gate — a kick beyond reach height cannot be triggered).
- **`main.js`'s animate loop** — `requestAnimationFrame` loop accumulates wall time × speed multiplier, steps the sim in a bounded `while` loop (guard `<50`), then calls `syncMeshes()`, `updateReadouts()`, `updateAxisLabels()`, `updateMouseCoordLabel()`, `updateBallCoordLabel()`, `renderer.render(...)` in that order every frame.
- **`resettableInputs[]`** — array populated by every `attachInfoButton()` call; the "Reset ALL parameters" button iterates this array to restore every slider to its `DEFAULT_PARAMS`/`KICK_DEFAULTS` value.

## Build & Test
- **No build step.** Open `index.html` in a browser, or serve statically: `py -m http.server 8000` from this directory.
- **Syntax check** (fast, no browser needed): `node --check main.js` and `node --check physics.js` — run this after ANY edit to either file.
- **Physics regression check**: `node debug_trace.js [power] [dir] [loft] [cycles] [paramOverridesJSON]` — headless kick trace, writes `logs/trace_<timestamp>.log` (gitignored) with per-cycle `x,y,z,vx,vy,vz,speed` plus a peak-height summary. Use this to verify any change to `kick()`/`step()` before trusting the visual result — e.g. `node debug_trace.js 100 0 60 60` should show a real airborne arc (several meters peak height), not a near-zero hop.
- There is no automated assertion-based test suite — `debug_trace.js` output must be inspected manually (peak height / bounce count / settle cycle) against expectations.

## Integration Points
- **rcssserver** ([../../rcssserver](../../rcssserver)) is the reference codebase this tool prototypes against — constants and formulas here are ported from `src/serverparam.cpp` (`ServerParam` constants), `src/player.cpp` (`Player::kick()`, `ballKickable()`), and `src/object.cpp` (`MPObject::_inc()` integration convention). When rcssserver's real formulas change, re-check this tool's `physics.js` for drift.
- **GitHub repo**: `git@github.com:rcsoccersim2-5D/3d-kick-lab.git`, branch `main`. `.gitignore` excludes `logs/` and `*.log` — never commit debug trace output.
- No CI configured for this project (unlike rcssserver's CircleCI).

## Important Notes
- **Never multiply position/velocity integration by `dt`** inside `physics.js` — see "Critical Convention" above.
- **Three.js cylinder rotation axes**: rotating a default-oriented (Y-axis-aligned) cylinder about `Z` maps its axis onto `X`; rotating about `X` maps it onto `Z`. The goal crossbar previously had this backwards (`rotation.z` instead of `rotation.x`) — double-check axis choice whenever rotating a primitive to span a specific world axis.
- **`git init` defaults to branch `master`** unless `init.defaultBranch` is configured — if you ever need to re-init or troubleshoot pushes, check `git branch` before assuming `main` exists locally.
- GitHub Pages is not enabled by default for this repo — hosting requires a manual one-time Settings → Pages → Deploy from branch (`main`, root) toggle.
