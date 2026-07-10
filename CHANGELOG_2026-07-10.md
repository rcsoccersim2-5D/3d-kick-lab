# Formula/Params Changelog — 2026-07-10

Short summary of every physics-formula and parameter change made this
session, for quick reference. See [physics.js](physics.js),
[main.js](main.js), and [copilot-instructions.md](.github/copilot-instructions.md)
for the full technical detail behind each line.

## Merged

- **`ball_bounce_restitution` + `ball_bounce_friction` → `ball_bounce_restitution`**
  Old model: `vz` reflected & scaled by `ball_bounce_restitution` (vertical only),
  `vx`/`vy` separately reduced by a Coulomb-friction-style coupling
  (`ball_bounce_friction`). New model: ONE coefficient scales the ball's
  **entire velocity vector** (`vx`, `vy`, and the just-reflected `vz`) on
  every bounce — a single uniform "whole-speed" energy loss instead of two
  overlapping per-axis params. Implemented in `_applyBounceEnergyLoss()`.
  Default stays `0.5`.

## Removed

- **`air_decay`** — deleted entirely. There is now simply **no horizontal
  friction while the ball is airborne** (`ball_decay` only applies once the
  ball is on the ground). Previously `air_decay=0.999` gave a tiny bit of
  drag in-flight; now it's exactly `1` (no drag) by construction, no slider.
- **`loft_power_cost`** — deleted entirely. Kicking upward no longer "costs"
  extra power. `horiz`/`vert` are now a **pure geometric split**
  (`effPower·cos(loft)`, `effPower·sin(loft)`) of the *same* total magnitude
  — no axis is more "expensive" to aim at than another. Net effect: lofted
  kicks now fly noticeably higher/farther than before at the same power
  (e.g. a `loft=60°` kick's peak height went from ~6.75m to ~12.95m at the
  old `gravity=0.15`, since it no longer loses ~27% of its power to the old
  loft penalty).
- **`dt`** — removed from `DEFAULT_PARAMS` (no more slider). It only ever
  paced real-time `Play` cadence in `main.js` and was NEVER used inside the
  physics formulas themselves, so having it as a tunable "physics parameter"
  was misleading. It's now a fixed module-level constant, `CYCLE_DT = 0.1`,
  exported from `physics.js` (`window.CYCLE_DT` / `module.exports.CYCLE_DT`)
  for `main.js`'s playback loop to use directly.

## Changed defaults

- **`gravity`**: `0.15` → **`0.1`**. Lower gravity = longer hang time / higher
  arcs at the same kick power. (History: `9.8` real-world value was the
  original bug → `0.25` → `0.15` → `0.1` now.)

## Bug fixed

- **Resting/rolling balls were losing 50% of their speed every single cycle.**
  The "ground collision / bounce" block in `step()` was gated only by
  `!bounced && pos.z <= 0` — true on EVERY cycle a ball spends resting on the
  ground (not just on a genuine new impact), because a resting ball never
  sets `bounced=true`. This meant `_applyBounceEnergyLoss()` (scaling
  `vx`/`vy` by `ball_bounce_restitution`, default `0.5`) fired every cycle on
  top of the normal `ball_decay` friction — a `power=100, loft=0` grounder
  stopped after ~5 cycles at `x≈5m` instead of the expected rcssserver-like
  `~40m`. **Fix**: added a `!resting` guard —
  `if (!resting && !bounced && b.pos.z <= 0)` — so the block only fires on a
  genuine new impact. Verified: the same grounder now travels `x≈39.3m`,
  settling at cycle 62 (matches the theoretical `v0/(1-ball_decay)` distance).

## Net effect on defaults (power=100, dir=0, ball at default kickable spot)

| Loft | Old peak height (gravity=0.15, loft_power_cost=0.4) | New peak height (gravity=0.1, no loft cost) |
|---|---:|---:|
| 0° (grounder) | 0m, stopped at ~5m (bug) | 0m, travels ~39m (fixed) |
| 60° | ~6.75m | ~19.9m |

## Files touched

- [physics.js](physics.js) — `DEFAULT_PARAMS`, `kick()`, `step()`, `_applyBounceEnergyLoss()`, `CYCLE_DT` constant, dual export guard.
- [main.js](main.js) — `PARAM_RANGES`, `DESCRIPTIONS`, kick-info readout, playback loop (`CYCLE_DT` usage).
- [README.md](README.md) — physics model section, parameter table, defaults table, notes.
- [.github/copilot-instructions.md](.github/copilot-instructions.md) — `KickLabPhysics`/`step()` description, critical-convention section, porting note.
