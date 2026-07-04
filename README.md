# 3D Kick Lab

A standalone, no-build-step browser sandbox for prototyping the "ball has
height" (3D kick / gravity / bounce) extension discussed for `rcssserver`.
Pure HTML + vanilla JS + Three.js (loaded from CDN) — just open `index.html`,
no npm/webpack/React required.

## How to run

**Easiest:** double-click [index.html](index.html) to open it directly in a
browser (Chrome/Edge/Firefox). It loads Three.js + OrbitControls from a CDN,
so you need an internet connection the first time (browser will cache them).

**Or serve it locally** (avoids any browser file:// quirks), from this
directory:

```powershell
py -m http.server 8000
# then open http://localhost:8000/ in a browser
```

## What it simulates

- **Player**: fixed at the origin `(0,0)`, drawn as a blue cylinder,
  `player_height` tall (default 2m), always facing `+X` (yellow arrow).
- **Ball**: white sphere, defaults to `z = 0`, positioned just in front of the
  player at kicking distance. You can override its initial `x,y,z,vx,vy,vz`
  in the "Ball initial state" panel before hitting **Reset**.
- **Kick command**: `power` (0-100), `dir` (degrees, relative to the
  player's body facing — matches rcssserver's convention), and the new
  **`loft`** (0-90°, 0 = grounder exactly like today's server, 90 = straight
  up). Hitting **Kick** only works if the ball is within the kickable circle
  **and** within `player_reach_height` (so you can't "kick" a ball flying
  10m over your head) — mirrors the design discussion's height-gated
  kickable-area idea.
- **Playback**: **Step** advances exactly one physics cycle (`dt` seconds,
  default 0.1s, same cadence as rcssserver's 100ms cycle) so you can inspect
  frame-by-frame what a kick does. **Play/Pause** runs continuously at an
  adjustable speed multiplier. **Reset** puts the ball back to its
  configured initial state.
- **Trail**: a fading yellow line traces the ball's last ~600 positions so
  you can see the arc shape at a glance.

## The physics model (see [physics.js](physics.js) for the exact code)

This directly extends the formula found in rcssserver's
`Player::kick()` ([player.cpp](../rcssserver/src/player.cpp)) and
`MPObject::_inc()` ([object.cpp](../rcssserver/src/object.cpp)):

```
dir_diff   = angle between player's facing and the ball
dist_ball  = edge-to-edge gap between player and ball
eff_power  = power * kick_power_rate
           * (1 - 0.25*dir_diff/pi - 0.25*dist_ball/kickable_margin)
eff_power *= (1 - loft_power_cost * (loft/90deg))     // NEW: loft costs power

accel_xy   = polar(eff_power * cos(loft), dir + body_angle)
accel_z    = eff_power * sin(loft)                     // NEW

# per-cycle integration:
vz  += -gravity * dt
pos += vel * dt
if pos.z <= 0: pos.z = 0; vz = -vz * restitution        # NEW: bounce
vx,vy *= (airborne ? air_decay : ball_decay)             # xy friction unchanged on the ground,
                                                          # ~frictionless while airborne
```

All parameters (`gravity`, `ball_bounce_restitution`, `loft_power_cost`,
`air_decay`, `player_reach_height`, plus every existing `ServerParam`-style
constant) are live sliders in the right-hand panel — this is meant as a
tuning lab: change one constant, Step/Play, watch the arc, repeat.

## Files

| File | Purpose |
|---|---|
| [index.html](index.html) | Page layout + UI panel markup |
| [style.css](style.css) | Dark-theme styling for the control panel |
| [physics.js](physics.js) | The physics engine — framework-free, easy to port back to C++ |
| [main.js](main.js) | Three.js scene (field/goal/player/ball/trail) + UI wiring + animation loop |

## Known bug (fixed) — "ball just hops a little then rolls"

**Symptom:** kicking with high `loft` (e.g. power=100, dir=0, loft=80) made
the ball barely leave the ground before immediately continuing to roll
flat, instead of flying up like a real lob.

**Root cause:** unit mismatch between the kick formula and the integrator.
The kick formula's output velocities are on **rcssserver's own per-cycle
scale** (`ball_accel_max=2.7`, `ball_speed_max=3.0` are "distance units
added directly each cycle", not m/s — rcssserver's `MPObject::_inc()` does
`pos += vel` with no `dt` multiplication anywhere). The original
`step()` in [physics.js](physics.js) instead multiplied by `dt` (0.1s) a
second time when integrating position, AND used a real-world
`gravity = 9.8` (m/s²) which, combined with that same `dt`, cancelled
almost the entire kick's vertical velocity (~1.5 units) in a single step.
Net effect: the ball rose only a few centimeters before gravity had
already eaten all of its upward velocity.

**Fix applied** (see [physics.js](physics.js) `step()`, and the comment
block right above it):
- Position/velocity integration is now purely **per-cycle** (`pos += vel`,
  `vel.z += -gravity`), matching rcssserver's actual convention — no `dt`
  multiplication inside the physics at all. `dt` is kept only as metadata
  for real-time playback pacing in `main.js`.
- Default `gravity` changed from `9.8` to **`0.25`** (same per-cycle unit
  scale as the kick velocities) — this is the single most important
  parameter for "does the ball go up like a real soccer game":
  - **Lower `gravity` (e.g. 0.05-0.15)** → long, floaty lob (hangs for many
    cycles, good for a deep chip pass).
  - **Higher `gravity` (e.g. 0.4-0.8)** → snappier, lower arc (good for a
    quick header/volley feel).
  - `gravity ≥ ~2-3` will look like the old bug again (ball barely rises)
    because it will out-power any kick's vertical velocity within 1-2
    cycles — avoid values anywhere near "9.8", that was real-world m/s²
    and is NOT the right scale for this per-cycle simulation.

**Verified with the headless trace tool** (see below) using your exact
reported params (`power=100, dir=0, loft=80`): peak height **3.75m at
cycle 5**, ball comes down, bounces three times with decreasing height
(restitution 0.65), and settles to rolling by ~cycle 20 — a proper arc
instead of a flat hop.

## Debugging tool: `debug_trace.js` (writes a log file you can inspect/share)

Since the simulation runs in-browser, there's no automatic server-side log
— but you now have two ways to capture one:

1. **In-browser:** click **"Export trace (.json)"** at the bottom of the
   panel any time — it downloads the full parameter set, kick result, ball
   trail (every cycle's x/y/z/vx/vy/vz), and event log as a `.json` file
   you can inspect or send over.
2. **Headless (Node), no browser needed:** run the same physics engine
   from the command line and get a plain-text CSV-style log under `logs/`:

   ```powershell
   cd D:\workspace\robo\ss2d\3d-kick-lab
   node debug_trace.js 100 0 80 60
   # optional 5th arg: JSON param overrides, e.g.
   node debug_trace.js 100 0 80 60 "{\"gravity\":0.4,\"ball_bounce_restitution\":0.8}"
   ```

   This writes `logs/trace_<timestamp>.log` with one line per cycle
   (`cycle,x,y,z,vx,vy,vz,speed`), the exact kick-formula intermediate
   values (`dir_diff`, `dist_ball`, `eff_power`, `accel`), every bounce/
   settle event, and a summary line with peak height + cycle reached —
   useful for quickly A/B-testing a parameter change without opening a
   browser at all.

## Ball stops simulating once resting/rolling to a halt (and two related bounce bugs fixed)

Three related changes so the sim doesn't keep computing an effectively-motionless ball forever:

1. **New parameter `roll_stop_speed` (default 0.05)** — once a ball resting on the ground (already
   vertically settled) has its horizontal (x,y) speed decay below this value, it freezes completely
   (`vx=vy=0`) and an event `"Ball stopped rolling."` is logged. This is separate from
   `bounce_stop_speed`, which only governs the vertical bounce → settle transition. Slider + `!`/`↺`
   buttons added alongside the other physics parameters.
2. **Fixed: a resting ball never actually settled vertically.** With the defaults (`gravity=0.15` >
   `bounce_stop_speed=0.05`), gravity alone exceeds the settle threshold every cycle, so a ball already
   at rest kept "falling" 0.15/cycle, bouncing back up, and repeating forever — confirmed via
   `debug_trace.js` (a pure grounder kick, `loft=0`, bounced at a constant `vz≈0.06` indefinitely
   instead of never leaving the ground at all). Fixed by skipping the gravity/position-integration step
   entirely while the ball is already resting (`pos.z<=0 && vel.z===0`) — any kick or velocity change
   makes `vel.z` non-zero again next cycle, so gravity resumes normally.
3. **Fixed: airborne bounces could also converge to a stable non-decaying oscillation.** The settle
   check compared the *incoming* fall velocity to `bounce_stop_speed`, but that incoming velocity
   converges to a fixed value around `gravity` every cycle and can never dip below the threshold if
   `gravity > bounce_stop_speed` — so a loft kick's bounces settled down to a small amplitude
   (`vz≈0.06`) and then bounced there forever instead of finally stopping. Fixed by checking the
   *predicted post-bounce* velocity against `bounce_stop_speed` instead of the incoming one, so the
   ball now settles for good a couple of bounces after crossing the threshold.

Verified end-to-end with `node debug_trace.js 100 0 60 130`: kick → 5 decaying bounces → settles
vertically at cycle 44 → rolls and decays → `"Ball stopped rolling."` fires at cycle 85, after which
the ball is fully at rest.

## Step scrubber bar + kick auto-starts playback

- **Step bar**: a new range slider ("Step X / Y") next to the Speed control in the Playback section.
  Every simulated cycle now records a full snapshot (position + velocity) in `sim.history`
  (see `KickLabPhysics.gotoStep()` in [physics.js](physics.js)); dragging the bar jumps straight to that
  cycle without re-running the physics, so you can scrub back and forth through a kick's whole
  trajectory. `Step ⏭`/`Play ▶`/`Pause ⏸` still work exactly as before and keep the bar in sync every
  frame.
- **Kick auto-starts playback**: clicking `Kick ⚽` now automatically starts Play (equivalent to
  clicking `Play ▶` yourself) whenever the kick was valid, so the ball's flight is immediately visible
  instead of requiring a separate manual step. You can still `Pause ⏸` or drag the Step bar at any time
  to inspect a specific cycle.

## Per-variable reset (↺) and "Reset ALL parameters"

- Every slider (Power/Direction/Loft, and all physics parameters) now has a
  small **"↺"** button right next to its **"!"** info button. Click it to snap
  just that one variable back to its default value — handy after you've been
  experimenting and want to isolate the effect of a single change again.
- **"Reset ALL parameters"** (top of the "Physics parameters" section) resets
  every kick + physics slider to its default in one click.
- Neither of these touches the ball's position/velocity — that's still the
  job of the separate **"Reset ⟲"** button in the Playback section, which
  resets the simulation state (cycle count, trail, ball pos/vel) using
  whatever is currently in the "Ball initial state" fields. The two reset
  concerns (parameters vs. simulation state) are kept independent on purpose.

## Ball trail visibility fix

**Symptom:** from some camera angles (especially top-down/grazing angles),
the yellow ball trail became hard to see or seemed to disappear entirely.

**Cause:** the trail line sat exactly on the ground plane (`y=0`), co-planar
with the field mesh and grid helper (also at `y≈0`) — floating-point depth
precision made the thin line "z-fight" with the ground and flicker in and
out depending on viewing angle; on top of that, a plain `THREE.Line` is only
1px wide in WebGL (linewidth is ignored on most GPUs/browsers), so it was
easy to lose even when it *was* rendering.

**Fix** (see [main.js](main.js), trail setup near `MAX_TRAIL`):
- The trail is now rendered with `depthTest: false` and a high `renderOrder`,
  so it always draws **on top of** the field/grid instead of fighting with
  them for the same depth-buffer pixels.
- It's lifted a small fixed amount (`TRAIL_LIFT = 0.04`) above the ball's
  true height, purely visually (the ball mesh itself is NOT shifted — only
  the trail line/points use the lift).
- Small always-visible point markers (`THREE.Points`, size-attenuated) were
  added along the same path as the line, since dots are easier to spot than
  a 1px line from an end-on or steep angle.

## "!" info buttons — understand what each variable does

Every kick parameter (Power/Direction/Loft) and every physics parameter in the
"Physics parameters" panel now has a small **"!"** button next to its label.
Click it to toggle a short explanation (right in the panel, no popup) of:

- What the variable represents (and its rcssserver equivalent constant, where
  one exists — e.g. `kick_power_rate`, `ball_decay`, `ball_speed_max`).
- **How changing it affects the simulation** — e.g. *"loft costs power: at
  loft=90 with loft_power_cost=0.4 you only keep 60% of eff_power"*, or
  *"gravity is per-cycle, NOT real 9.8 m/s² — setting it too high reproduces
  the 'ball barely leaves the ground' bug"*.

Click the button again to collapse the explanation. All descriptions live in
one `DESCRIPTIONS` map in [main.js](main.js) — easy to extend if you add new
parameters later.

## New defaults (tuned for a realistic first-look arc)

| Parameter | Old default | New default |
|---|---|---|
| Power | 60 | **100** |
| Loft | 30° | **60°** |
| Ball initial x | ~0.74 (kickable-edge distance) | **0.3** |
| Gravity | 0.25 | **0.15** |

With these defaults, hitting **Kick** immediately now produces a strong,
high, floaty lob (peak height ≈ 6.75m at cycle 10, verified with
`node debug_trace.js 100 0 60 60`) — a clearer "yes, this really flies"
demo than the previous more modest defaults.

## Real pitch dimensions and goal distance

The field/goal geometry now matches rcssserver's actual `ServerParam` constants
(from [serverparam.cpp](../rcssserver/src/serverparam.cpp)) instead of arbitrary
lab-scale numbers:

- **Pitch**: `105 x 68` (rcssserver's `PITCH_LENGTH`/`PITCH_WIDTH`), centered on
  the origin `(0,0)` — same convention as the real server's coordinate system.
- **Goal distance from center**: `x = ±52.5` (exactly `PITCH_LENGTH / 2`) — both
  goals are drawn now (the attacking one at `+52.5` and the mirrored own-goal at
  `-52.5`) so the pitch looks complete.
- Explicit `x=52.5 (goal)` / `x=-52.5 (goal)` tick labels were added along the
  field edge so the goal-line distance is directly readable, not just implied by
  the mesh position.
- Camera default position/orbit target were pulled back (`camera.position` and
  `controls.target` in [main.js](main.js)) since the pitch is now much larger
  than the old placeholder 30x20 lab field.

## Field coordinates, live labels, and a goal-post fix

- **Goal crossbar orientation fixed** — the crossbar mesh is a `THREE.CylinderGeometry`
  whose default axis is Y. It needs to span the Z axis (it connects the two goal
  posts, which sit at `z = -goalWidth/2` and `z = +goalWidth/2`). The code was
  rotating it `bar.rotation.z = Math.PI/2`, which rotates the Y-axis onto **X**
  (wrong plane — this was the "90° off" bug you saw). Fixed to
  `bar.rotation.x = Math.PI/2`, which correctly rotates Y onto **Z**. See
  [main.js](main.js), `buildGoal()`.
- **Field x/y number labels**: small tags are stamped every 5 units along the two
  near edges of the pitch (`x=0, x=5, x=10, ...` and `y=-10, y=-5, ..., y=10`),
  plus an `origin (0,0)` tag — these are plain DOM `<div>`s projected from 3D world
  space to screen space every frame (`worldToScreen()` in [main.js](main.js)), so
  they stay pinned to the ground as you orbit the camera.
- **Mouse-hover field coordinates**: moving the mouse over the green pitch raycasts
  against the field mesh and shows a small yellow "x=.., y=.." tooltip that follows
  the cursor (hidden when the pointer leaves the field). See
  `updateMouseCoordLabel()` in [main.js](main.js).
- **Ball coordinate label**: a blue tag now floats just above the ball at all times
  showing its live `x=.., y=.., z=..` — same screen-projection technique as the
  field labels, updated every rendered frame.

## Notes / things to try next

- Set `loft_power_cost = 0` and `gravity` very low to sanity-check the
  degenerate case (`loft=0`) exactly reproduces today's flat-ground kick.
- Crank `ball_bounce_restitution` toward 0.9+ to see a "bouncy ball" instead
  of a realistic dead-ball settle.
- Set an initial `vz` and `z` directly (bypassing `kick()`) to test "what
  does a header look like" without needing a second player model.
- The kickable-area check already gates on `player_reach_height` — try
  kicking a high ball and see the "not kickable" message, then wait for it
  to fall within reach.
