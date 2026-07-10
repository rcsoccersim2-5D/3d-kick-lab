# 3D Kick Lab

A standalone, no-build-step browser sandbox for prototyping the "ball has
height" (3D kick / gravity / bounce) extension discussed for `rcssserver`.
Pure HTML + vanilla JS + Three.js (loaded from CDN) — just open `index.html`,
no npm/webpack/React required.

> **Formula simplified 2026-07-10** — see [CHANGELOG_2026-07-10.md](CHANGELOG_2026-07-10.md)
> for a short summary of every param that was merged/removed and why
> (`ball_bounce_friction` merged into `ball_bounce_restitution`, `air_decay`
> and `loft_power_cost` removed entirely, `dt` is now a fixed constant, a
> resting-ball bounce-friction bug was fixed, and `gravity`'s default changed).
> Some of the historical sections further down this README describe the
> OLDER multi-parameter model and are kept for context/history — the
> "Current physics model" section right below is up to date.

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
  **and** within `player_height` (so you can't "kick" a ball flying
  10m over your head) — mirrors the design discussion's height-gated
  kickable-area idea.
- **Playback**: **Step** advances exactly one physics cycle (a fixed
  `CYCLE_DT = 0.1s` constant in [physics.js](physics.js), same cadence as
  rcssserver's 100ms cycle — no longer a tunable slider, since it only
  paces real-time playback and was never used inside the physics itself)
  so you can inspect frame-by-frame what a kick does. **Play/Pause** runs
  continuously at an adjustable speed multiplier. **Reset** puts the ball
  back to its configured initial state.
- **Trail**: a fading yellow line traces the ball's last ~600 positions so
  you can see the arc shape at a glance.

## The physics model (see [physics.js](physics.js) for the exact code)## Current physics model (see [physics.js](physics.js) for the exact code)

This directly extends the formula found in rcssserver's
`Player::kick()` ([player.cpp](../rcssserver/src/player.cpp)) and
`MPObject::_inc()` ([object.cpp](../rcssserver/src/object.cpp)):

```
dir_diff   = angle between player's facing and the ball
dist_ball  = edge-to-edge gap between player and ball
eff_power  = power * kick_power_rate
           * (1 - 0.25*dir_diff/pi - 0.25*dist_ball/kickable_margin
                - height_power_cost*height_frac)

# pure geometric split - NO extra power cost for loft angle (loft_power_cost
# was removed 2026-07-10): a kick is a fixed-magnitude force vector, no axis
# is "more expensive" to aim at than another.
accel_xy   = polar(eff_power * cos(loft), dir + body_angle)
accel_z    = eff_power * sin(loft)

# per-cycle integration (CYCLE_DT=0.1s is metadata for playback pacing ONLY,
# never multiplied into the physics itself):
vz  += -gravity                                    # gravity skipped while resting
pos += vel
if pos.z <= 0:                                      # bounce (precise_bounce_timing finds
                                                     # the exact crossing instant, default ON)
    pos.z = 0
    vz = -vz                                        # reflect
    (vx, vy, vz) *= ball_bounce_restitution          # single coefficient scales the WHOLE
                                                      # velocity vector - one uniform energy
                                                      # loss across all 3 axes, applied ONLY
                                                      # on a genuine new impact (never while
                                                      # already resting - see bug fix below)
vx,vy *= (airborne ? 1 (no friction) : ball_decay)   # xy friction ONLY on the ground;
                                                      # air_decay was removed - horizontal
                                                      # speed is fully conserved while airborne
```

All parameters (`gravity`, `ball_bounce_restitution`, `player_height`,
`height_power_cost`, plus every existing `ServerParam`-style constant) are
live sliders in the right-hand panel — this is meant as a tuning lab: change
one constant, Step/Play, watch the arc, repeat.

## New parameters compared to rcssserver (the 2D server)## New parameters compared to rcssserver (the 2D server)

Everything rcssserver already has (`ball_decay`, `kick_power_rate`,
`kickable_margin`, `ball_speed_max`, `ball_accel_max`, `ball_size`,
`player_size`, `max_power`) is kept exactly as-is. Everything below is
**new**, added only to make the ball move in 3D (have height) and bounce.
Plain-language explanation of each one:

| Parameter | What it means, in simple terms |
|---|---|
| `loft` | How high you aim the kick (0-90°). `0` = a normal flat kick, just like today's server. `90` = straight up in the air. Does NOT cost any extra power to aim higher — see `loft_power_cost` removal below. |
| `gravity` | How fast the ball falls back down. Lower = the ball hangs in the air longer (a floaty lob). Higher = it drops quickly. Default **`0.1`** (was `0.15`, was `9.8` originally — the real bug fix). |
| `ball_bounce_restitution` | How "bouncy" the ball is, applied to the ball's ENTIRE velocity (up/down AND sideways together, as one uniform energy loss) every time it hits the ground. `0` = dead stop on first touch. Close to `1` = keeps bouncing almost as high/fast as before. Default `0.5`. **(Merged 2026-07-10 with the old separate `ball_bounce_friction` param — see [CHANGELOG_2026-07-10.md](CHANGELOG_2026-07-10.md).)** |
| `bounce_stop_speed` | Once the ball's bounces get small/slow enough, it just stops bouncing and settles flat on the ground instead of bouncing forever in tinier and tinier hops. |
| `roll_stop_speed` | Once a ball rolling on the ground gets slow enough, it just stops completely instead of creeping along forever at a crawl. |
| `player_height` | How tall the player is (visual cylinder height) **and** how high up they can still reach the ball (merged from a former separate `player_reach_height` param — the two always shared the same default, so they're now one slider). A ball flying above this height is "too high" — the player can't kick/head it. |
| `height_power_cost` | Kicking a ball that's already up in the air (like a header) costs a bit more power than kicking the same ball on the ground. |
| `precise_bounce_timing` | A toggle for *how* the bounce is calculated. **ON (default)**: finds the exact instant the ball touches the ground for a smooth, accurate bounce. **OFF**: an older, simpler method kept only so you can compare the two. |

**Removed (2026-07-10)** — see [CHANGELOG_2026-07-10.md](CHANGELOG_2026-07-10.md) for details:
- `ball_bounce_friction` — merged into `ball_bounce_restitution` above (one coefficient now scales the whole velocity vector instead of two separate axis-specific ones).
- `air_decay` — removed entirely; there is now simply NO horizontal friction while the ball is airborne (only `ball_decay` on the ground).
- `loft_power_cost` — removed entirely; aiming higher no longer costs extra kick power, only redirects the same total power from horizontal into vertical.
- `dt` — no longer a tunable parameter; it's a fixed `CYCLE_DT=0.1` constant in [physics.js](physics.js), since it only paced real-time playback and was never used inside the physics formulas.

All of these live in `DEFAULT_PARAMS` in [physics.js](physics.js) and have
their own slider + "!" info button in the app if you want the full technical
description (which rcssserver formula it extends, exact default value, etc.).

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

## Ball height now affects kick power (new `height_power_cost` parameter)

Previously, ball height (`z`) had **zero** effect on kick power — `isBallKickable()` only applied a
binary reach cutoff (`z <= player_height`, formerly a separate `player_reach_height` param — since merged), so a header at head height cost exactly the same
power as a grounder at the player's feet, unlike horizontal distance/angle which already reduce power
continuously (see `distBall`/`dirDiff` in `kick()`).

Added a `heightFrac = ball.z / player_height` term (0 = ball on the ground, 1 = right at the
reach-height cutoff) to the `eff_power` formula, weighted by a new tunable **`height_power_cost`**
(default **0.25**, matching the existing fixed `0.25` weight already used for angle/distance):

```js
effPower = power * kick_power_rate * (
  1 - 0.25 * dirDiff / PI
    - 0.25 * distBall / kickable_margin
    - height_power_cost * heightFrac        // NEW
);
```

Set `height_power_cost` to 0 to restore the old "height is free" behavior; raise it (up to 1.0) to make
headers/volleys progressively weaker the higher the ball is. Verified numerically (same x/y/angle,
`power=100`, `player_height=2.0`, default `height_power_cost=0.25`):

| ball z | height_frac | eff_power |
|---|---|---|
| 0    | 0.000 | 2.589 |
| 1    | 0.500 | 2.252 |
| 1.9  | 0.950 | 1.948 |
| 2.01 | — | rejected (`isBallKickable()` = false, beyond `player_height`) |

The kick-info readout in the UI now also shows `height_frac` alongside `dir_diff`/`dist_ball`, and a
new slider (with `!`/`↺` buttons, same pattern as every other physics parameter) was added for
`height_power_cost`.

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
| Gravity | 0.25 → 0.15 | **0.1** (as of 2026-07-10) |

With the current defaults (`power=100, loft=60, gravity=0.1`), hitting
**Kick** produces a strong, high, floaty lob — peak height ≈ 19.9m at cycle
20, final settle distance ≈ 62.6m (verified with
`node debug_trace.js 100 0 60 100`; heights are higher than earlier
`gravity=0.15`-era numbers quoted elsewhere in this doc, since gravity has
been lowered twice since this section was written and `loft_power_cost` was
also removed, both of which increase arc height/hang-time).

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

## Impact friction couples the bounce to horizontal speed (new `ball_bounce_friction`), and precise bounce timing is now the default

> **Superseded 2026-07-10**: `ball_bounce_friction` (introduced in this
> section) was later merged directly into `ball_bounce_restitution` — see
> [CHANGELOG_2026-07-10.md](CHANGELOG_2026-07-10.md). This section is kept
> for historical context on *why* the friction-coupling idea was introduced
> in the first place; `precise_bounce_timing` defaulting to `true` is still
> current.

Previously a ground bounce only ever touched **vertical** speed
(`ball_bounce_restitution`) — the horizontal (x,y) speed was completely
untouched by the bounce itself, only slowly bled off afterwards by the
separate, continuous `ball_decay`/`air_decay` friction. That's not how a
real ball loses energy: hitting the ground hard (a big vertical impact)
should also cost you some horizontal speed on that same instant, because
the impact is a single physical event, not two independent axes.

This mirrors how the 3D league (SimSpark, built on the ODE physics engine)
resolves a bounce: ODE's contact solver treats the normal (vertical) and
tangential (horizontal/friction) impulses as one coupled Linear
Complementarity Problem, with the tangential impulse capped by
`mu * normalImpulse` (a Coulomb friction pyramid) — see
[`compare.md`](compare.md) for the full three-way trace through
rcssserver / SimSpark / this lab.

1. **New parameter `ball_bounce_friction` (default 0.3)** — at every ground
   bounce, `_applyBounceFriction()` computes `normalImpulse = |vz before
   bounce| - |vz after bounce|` (how much vertical speed the bounce just
   absorbed), then scales the ball's horizontal speed down by up to
   `ball_bounce_friction * normalImpulse` (clamped so it can never reverse
   direction or go negative). `0` reproduces the old behavior exactly
   (bounce never touches vx/vy); higher values make a harder bounce bleed
   off proportionally more horizontal speed on that one impact. Slider +
   `!`/`↺` buttons added alongside the other physics parameters.
2. **`precise_bounce_timing` default changed from `false` to `true`.**
   Investigating rcssserver's own goal-post collision code
   (`MPObject::intersect()`/`nearestPost()` in `object.cpp`) showed it
   already uses a continuous/analytical time-of-impact scheme — the exact
   same idea as this lab's `precise_bounce_timing=true` mode (find the
   exact fractional point within the cycle where the crossing happens,
   then continue the remaining fraction with the reflected velocity)
   rather than the simpler discrete "clamp to the surface, discard the
   overshoot" scheme. Since that's the more accurate *and* more
   server-authentic behavior, it's now the default; the old discrete
   scheme is kept as the `false` legacy/experimental alternative for A/B
   comparison.

Verified with `node debug_trace.js 100 0 60 60`: with the new defaults
(`ball_bounce_friction=0.3`), the first bounce (cycle 19→20) drops horizontal
speed from `vx=0.8499` to `vx=0.6918` — a visible one-time loss right at
impact — vs. `vx=0.8499 → 0.8491` (i.e. no meaningful change) with
`ball_bounce_friction=0` reproducing the old behavior. The ball still settles
correctly (5 decaying bounces, "Ball settled on ground." at cycle 49, then
rolls out and "Ball stopped rolling." per the normal `roll_stop_speed`
check) — no infinite oscillation or divergence introduced.

## Notes / things to try next

- Set `gravity` very low to sanity-check the degenerate case (`loft=0`)
  exactly reproduces today's flat-ground kick (`loft_power_cost` no longer
  exists — a `loft=0` kick was never affected by it anyway, since the old
  penalty term was always `0` at `loft=0`).
- Crank `ball_bounce_restitution` toward 0.9+ to see a "bouncy ball" instead
  of a realistic dead-ball settle.
- Set an initial `vz` and `z` directly (bypassing `kick()`) to test "what
  does a header look like" without needing a second player model.
- The kickable-area check already gates on `player_height` — try
  kicking a high ball and see the "not kickable" message, then wait for it
  to fall within reach.
