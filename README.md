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
