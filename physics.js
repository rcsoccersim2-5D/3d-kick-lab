/*
 * physics.js — 3D kick / ball-flight physics lab
 *
 * Implements the "Option C" (ball fully 3D, player flat + reach height)
 * extension formula discussed for rcssserver:
 *
 *   eff_power   = power * kick_power_rate
 *               * (1 - 0.25*dir_diff/PI - 0.25*dist_ball/kickable_margin - height_power_cost*height_frac)
 *   horiz       = eff_power * cos(loft)     // pure geometric split - no axis costs extra
 *   vert        = eff_power * sin(loft)
 *   accel_xy    = polar(horiz, dir_rel + body_angle)
 *   accel_z     = vert
 *
 * Per-cycle integration (dt seconds per cycle, default 0.1s like rcssserver):
 *   vz   += -gravity * dt
 *   pos  += vel * dt
 *   if pos.z <= 0: pos.z = 0; vz = -vz; (vx,vy,vz) *= ball_bounce_restitution; (settle if too slow)
 *   vx,vy *= (airborne ? 1 (no air friction) : ball_decay)     // xy friction only on the ground
 *

 * All state/formulas are intentionally kept in ONE plain object graph
 * (no framework) so they are easy to read, tweak, and port back into
 * rcssserver's C++ (object.cpp / player.cpp) later.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Fixed seconds-per-cycle for real-time playback pacing ONLY (main.js's
// animate loop uses this to convert wall-clock time into "how many cycles to
// step()"). Matches rcssserver's real 100ms/cycle. NEVER used inside the
// physics formulas themselves (integration is purely per-cycle - see the
// header comment above) - this is metadata, not a tunable physics constant,
// which is why (as of 2026-07-10) it is a plain constant instead of a
// DEFAULT_PARAMS entry with its own UI slider.
const CYCLE_DT = 0.1;

// ---- Default tunable parameters (mirrors / extends ServerParam) ----
const DEFAULT_PARAMS = {
  // existing rcssserver constants (see serverparam.cpp)
  ball_size: 0.085,
  ball_decay: 0.94,        // xy friction while ball is ON THE GROUND
  ball_rand: 0.0,          // kick/roll noise magnitude (0 = deterministic, good for a lab)
  ball_speed_max: 3.0,
  ball_accel_max: 2.7,
  player_size: 0.3,
  kick_power_rate: 0.027,
  kickable_margin: 0.7,
  max_power: 100.0,

  // new params proposed for the 3D extension
  // NOTE: gravity is a PER-CYCLE velocity loss (same unit scale as kick_power_rate's
  // output), NOT the real-world 9.8 m/s^2 — because rcssserver's ball_speed_max=3.0 /
  // ball_accel_max=2.7 are themselves already "distance units per cycle", a "realistic"
  // gravity on that same scale is a small number. 9.8 was the original bug (it cancelled
  // almost the entire kick's vertical velocity in one step -> the "little hop" symptom).
  // 0.15 gives a nice multi-second hang time for a hard, high-loft kick; raise it for a
  // snappier/lower arc, lower it (e.g. 0.05-0.1) for a long floaty lob.
  gravity: 0.1,

  // MERGED (previously two separate params, `ball_bounce_restitution` +
  // `ball_bounce_friction`, that both tried to describe "how much energy a
  // bounce removes" from two different angles - one for vz only, one as a
  // friction coupling for vx/vy): a single coefficient now scales the BALL'S
  // ENTIRE VELOCITY VECTOR (all three axes, using the true 3D speed
  // sqrt(vx^2+vy^2+vz^2)) by this same factor at the instant of a ground
  // bounce, right after vz is reflected. 1.0 = perfectly elastic bounce (no
  // energy lost at all, on any axis); 0.0 = ball goes completely dead on
  // first ground touch (both vz AND vx/vy zeroed). This matches simple
  // real-world intuition - hitting the ground costs a soccer ball SOME
  // fraction of its total kinetic energy, not just its vertical energy -
  // and removes the need to tune two separate, overlapping sliders. Default
  // 0.5 (was the old ball_bounce_restitution default; old ball_bounce_friction
  // is gone entirely).
  ball_bounce_restitution: 0.5,

  // REMOVED (2026-07-10): `loft_power_cost` used to further scale down effPower
  // based on loft angle (kicking upward "cost" extra power on top of the
  // dirDiff/distBall/height penalties). Removed per design discussion: a kick
  // is just a force vector of magnitude effPower pointed at (dir, loft) - the
  // cos(loft)/sin(loft) split below is pure geometry (how that fixed-magnitude
  // vector distributes across horizontal/vertical), not something that should
  // cost extra power depending on which way it's aimed. No axis is privileged
  // over another. See kick() below - horiz/vert are now derived directly from
  // effPower with no extra multiplier.
  bounce_stop_speed: 0.05,  // |vz| below this on a ground touch => ball settles (z=0,vz=0)

  bounce_stop_speed: 0.05,  // |vz| below this on a ground touch => ball settles (z=0,vz=0)
  roll_stop_speed: 0.05,    // horizontal (xy) speed below this WHILE RESTING ON GROUND => ball freezes (vx=vy=0)


  // MERGED (previously two separate params, `player_height` + `player_reach_height`,
  // that always shared the same default 2.0 and were never meaningfully different in
  // the UI): player_height is now BOTH the visual cylinder height (m) AND the max
  // ball z at which the ball is still considered kickable/headable (used by
  // isBallKickable()/heightFrac below) - i.e. "how tall the player is" now directly
  // IS "how high they can reach", instead of two independently-tunable sliders that
  // could drift out of sync for no physical reason.
  player_height: 2.0,

  height_power_cost: 0.25,  // NEW: fraction of effPower lost as ball.z approaches player_height
                            // (mirrors the existing 0.25 weight already used for dirDiff/distBall below —
                            // previously ball height had ZERO effect on power, only a binary reach cutoff)

  // REMOVED (2026-07-10): `dt` used to be a tunable DEFAULT_PARAMS entry (with
  // its own UI slider) purely for real-time playback pacing - it was NEVER
  // used inside the physics formulas (integration is per-cycle, see header
  // comment above), only to convert wall-clock time into "how many cycles to
  // step()" in main.js's animate loop. Having it as a tunable param implied
  // (incorrectly) that it affected the simulation itself. It's now a fixed
  // module-level constant, CYCLE_DT (below), always 0.1s (rcssserver's real
  // 100ms cycle) - no slider, no per-run variation.


  // Toggle in the lab UI to A/B test. Default is now TRUE (changed from the original
  // false/"naive" default): when true, a cycle that would carry the ball below z=0
  // does NOT just clamp pos.z straight to 0 - step() instead finds the exact
  // fractional point within the cycle where z would have crossed 0 (linear
  // interpolation - a cycle moves the ball at a constant vel.z), bounces the
  // velocity at that instant, then continues moving for the REMAINING fraction of
  // the cycle with the reflected velocity - like "mirroring" the tail end of the
  // fall back upward instead of chopping it off, so the ball never visibly dips
  // below ground. When false (the ORIGINAL/legacy behavior, kept only for A/B
  // comparison), the cycle is integrated straight-line for its full length and any
  // overshoot past z=0 is silently discarded (post-hoc snap-to-zero). See step()
  // for the implementation of both branches.
  precise_bounce_timing: true,
};

class KickLabPhysics {
  constructor(params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.reset();
  }

  reset(overrides = {}) {
    const p = this.params;
    // Player is always fixed at the origin, facing +X.
    this.player = {
      pos: { x: 0, y: 0, z: 0 },
      bodyAngle: 0, // radians, 0 = facing +X
      size: p.player_size,
      height: p.player_height,
    };

    // Default ball spot: just inside kicking range, directly in front of the player.
    const defaultDist = p.player_size + p.ball_size + p.kickable_margin * 0.5;
    this.ball = {
      pos: { x: overrides.x ?? defaultDist, y: overrides.y ?? 0, z: overrides.z ?? 0 },
      vel: { x: overrides.vx ?? 0, y: overrides.vy ?? 0, z: overrides.vz ?? 0 },
    };

    this.cycle = 0;
    this.time = 0;
    this.trail = [{ ...this.ball.pos }];
    // Full-state snapshot history (pos+vel+cycle+time) used by the step scrubber
    // bar to jump directly to any past cycle without re-running physics. Kept
    // deliberately UNCAPPED (unlike `trail`, which is capped for render perf) so
    // cycle numbers always map 1:1 to array indices — Reset clears it.
    this.history = [this._snapshot()];
    this.maxHeightReached = this.ball.pos.z;
    this.lastKickInfo = null;
    this.events = []; // {cycle, text}
  }

  _snapshot() {
    return {
      cycle: this.cycle,
      time: this.time,
      pos: { ...this.ball.pos },
      vel: { ...this.ball.vel },
    };
  }

  // Jump the simulation directly to a previously-recorded cycle (scrubbing),
  // without re-stepping physics. Used by the Step bar in main.js.
  gotoStep(idx) {
    idx = Math.max(0, Math.min(idx, this.history.length - 1));
    const snap = this.history[idx];
    this.ball.pos = { ...snap.pos };
    this.ball.vel = { ...snap.vel };
    this.cycle = snap.cycle;
    this.time = snap.time;
    return idx;
  }

  // ---- distance helpers ----
  _dist2D(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  ballDistanceFromPlayer() {
    return this._dist2D(this.ball.pos.x, this.ball.pos.y, this.player.pos.x, this.player.pos.y);
  }

  kickableArea() {
    return this.params.player_size + this.params.ball_size + this.params.kickable_margin;
  }

  isBallKickable() {
    // Same 2D circle test as rcssserver's ballKickable(), PLUS a height-reach gate
    // for an airborne ball (heading/volleying), matching the design-discussion idea:
    // "ball must also be within jump/head reach when off the ground".
    const inCircle = this.ballDistanceFromPlayer() <= this.kickableArea();
    const inReach = this.ball.pos.z <= this.params.player_height;
    return inCircle && inReach;
  }

  // ---- KICK: apply one kick using rcssserver-derived formula + loft extension ----
  kick(power, dirDeg, loftDeg) {
    const p = this.params;
    if (!this.isBallKickable()) {
      this.lastKickInfo = { ok: false, reason: "Ball is not kickable (out of reach or too high)." };
      return this.lastKickInfo;
    }

    power = Math.max(-p.max_power, Math.min(p.max_power, power));
    const dir = dirDeg * DEG2RAD;                       // body-relative, like rcssserver's "dir"
    const loft = Math.max(0, Math.min(90, loftDeg)) * DEG2RAD;

    // angle from player's body facing to the ball (dir_diff in rcssserver)
    const angleToBall = Math.atan2(
      this.ball.pos.y - this.player.pos.y,
      this.ball.pos.x - this.player.pos.x
    );
    const dirDiff = Math.abs(this._normalizeAngle(angleToBall - this.player.bodyAngle));

    const distBall = this.ballDistanceFromPlayer() - p.player_size - p.ball_size;

    // Height penalty: how far UP the ball currently is, as a fraction of the
    // player's max reach height (0 = ball on the ground, 1 = right at the
    // reach-height cutoff, which is now the SAME `player_height` param used
    // for the visual cylinder). Previously ball.z had NO effect on effPower
    // at all — only a binary isBallKickable() cutoff, so a header at head
    // height cost exactly the same power as a grounder at the player's feet.
    // This mirrors the existing distBall/dirDiff terms so a higher ball is
    // now progressively harder to strike with full power, same idea as being
    // off-angle or at the edge of kickable_margin.
    const heightFrac = p.player_height > 0
      ? Math.max(0, this.ball.pos.z) / p.player_height
      : 0;

    let effPower = power * p.kick_power_rate *
      (1 - 0.25 * dirDiff / Math.PI
         - 0.25 * Math.max(0, distBall) / p.kickable_margin
         - p.height_power_cost * heightFrac);
    effPower = Math.max(0, effPower);

    // A kick is just a force vector of magnitude effPower pointed at (dir, loft).
    // horiz/vert are a pure geometric split of that SAME magnitude across the
    // horizontal/vertical axes (cos/sin) - no axis is "cheaper" or "more
    // expensive" to aim at than another, so unlike an earlier version of this
    // formula, loft does NOT reduce the total available power anymore.
    const horiz = effPower * Math.cos(loft);
    const vert = effPower * Math.sin(loft);

    const kickAngle = dir + this.player.bodyAngle;
    let accelX = horiz * Math.cos(kickAngle);
    let accelY = horiz * Math.sin(kickAngle);
    let accelZ = vert;

    // optional small kick noise (rcssserver-style), off by default (ball_rand=0)
    if (p.ball_rand > 0) {
      const maxRand = p.ball_rand * (power / p.max_power) * effPower;
      const noiseAngle = Math.random() * Math.PI * 2;
      const noiseMag = Math.random() * maxRand;
      accelX += noiseMag * Math.cos(noiseAngle);
      accelY += noiseMag * Math.sin(noiseAngle);
    }

    // clamp xy accel to ball_accel_max (z is gravity-governed, not clamped the same way)
    const accelXYMag = Math.sqrt(accelX * accelX + accelY * accelY);
    if (accelXYMag > p.ball_accel_max) {
      const s = p.ball_accel_max / accelXYMag;
      accelX *= s;
      accelY *= s;
    }

    this.ball.vel.x += accelX;
    this.ball.vel.y += accelY;
    this.ball.vel.z += accelZ;

    // clamp resulting xy speed to ball_speed_max (z is free — gravity will govern it)
    const speedXY = Math.sqrt(this.ball.vel.x ** 2 + this.ball.vel.y ** 2);
    if (speedXY > p.ball_speed_max) {
      const s = p.ball_speed_max / speedXY;
      this.ball.vel.x *= s;
      this.ball.vel.y *= s;
    }

    this.lastKickInfo = {
      ok: true,
      dirDiffDeg: dirDiff * RAD2DEG,
      distBall,
      heightFrac,
      effPower,
      accel: { x: accelX, y: accelY, z: accelZ },
    };
    this.events.push({ cycle: this.cycle, text: `Kick: power=${power}, dir=${dirDeg}°, loft=${loftDeg}° → accel=(${accelX.toFixed(2)},${accelY.toFixed(2)},${accelZ.toFixed(2)})` });

    // A kick changes velocity instantly but position only moves on the NEXT
    // step() — update the current cycle's history snapshot in place so
    // scrubbing back to this exact cycle shows the post-kick velocity.
    if (this.history.length > 0) {
      this.history[this.history.length - 1].vel = { ...this.ball.vel };
    }
    return this.lastKickInfo;
  }

  _normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  // ---- BUG FIX: perpetual-bounce guard ----
  // Root cause (found via debug_trace.js parameter sweeps): the naive settle
  // test `|candidate| < bounce_stop_speed` only ever looks at ONE bounce in
  // isolation. But when gravity is large enough relative to bounce_stop_speed
  // (fully reachable from the gravity slider, e.g. gravity >= ~0.5 with the
  // default restitution=0.5), the ball never gets a full cycle of hang time —
  // it re-touches the ground on every single step() call. In that degenerate
  // "always touching" regime the per-cycle recurrence is
  //   vz_(n+1) = restitution * (gravity - vz_n)
  // which is a contraction (error shrinks by `restitution` each cycle) that
  // converges to a NONZERO fixed point:
  //   vzStar = restitution * gravity / (1 + restitution)
  // If vzStar >= bounce_stop_speed, the ball converges to — and then sits at —
  // a constant-amplitude bounce FOREVER, since the flat velocity threshold is
  // never crossed (verified: gravity=0.5/1.0/1.5/2.0 with restitution=0.5 all
  // reproduce this, none of them ever settle even after 2000+ cycles). This
  // reproduces the "ball bounces again and again forever" bug report exactly,
  // and happens with BOTH precise_bounce_timing=ON and OFF (same threshold
  // check, same recurrence — this is not a timing-mode issue).
  //
  // Fix: settle whenever the candidate speed is at-or-below this analytic
  // fixed point (with a tiny tolerance), IN ADDITION TO the existing
  // bounce_stop_speed check. This guarantees termination for ANY
  // gravity/restitution combination reachable from the sliders. It does NOT
  // affect normal, genuinely-airborne multi-cycle bounce decays (their real
  // hang time each bounce means they cross below bounce_stop_speed via the
  // ordinary per-bounce restitution decay long before ever approaching this
  // degenerate fixed point — verified: default and moderate-restitution cases
  // settle at the same cycle as before this fix).
  _bounceSettleThreshold() {
    const p = this.params;
    if (p.ball_bounce_restitution >= 1 || p.gravity <= 0) return p.bounce_stop_speed;
    const vzStar = (p.ball_bounce_restitution * p.gravity) / (1 + p.ball_bounce_restitution);
    return Math.max(p.bounce_stop_speed, vzStar * 1.0001);
  }

  // ---- Bounce energy loss: scale the ball's ENTIRE velocity vector (vx,
  // vy, and the just-reflected vz) by the single ball_bounce_restitution
  // coefficient, once per ground-touch event. This is a uniform "whole-speed"
  // energy loss (matching how a real ball loses some fraction of its total
  // kinetic energy on every bounce, not just its vertical component) - it
  // replaces the old two-parameter model (separate vz-only restitution +
  // a Coulomb-friction-style vx/vy coupling). Call this ONCE per ground-touch,
  // right after vel.z has been reflected (or zeroed on settle).
  _applyBounceEnergyLoss() {
    const p = this.params;
    const b = this.ball;
    b.vel.x *= p.ball_bounce_restitution;
    b.vel.y *= p.ball_bounce_restitution;
  }


  // ---- STEP: advance the simulation by exactly one cycle ----
  //
  // IMPORTANT UNIT NOTE (bug fix): the kick formula above produces
  // velocities on rcssserver's own scale, where ball_accel_max=2.7 and
  // ball_speed_max=3.0 are already "distance units PER CYCLE" (rcssserver
  // does `pos += vel; vel *= decay` with NO dt multiplication anywhere —
  // see object.cpp's MPObject::_inc()). So integration here must ALSO be
  // per-cycle (pos += vel, vel.z += -gravity), NOT per-second with a `*dt`
  // multiply — multiplying by dt=0.1 a second time was the original bug:
  // it both shrank the visible displacement ~10x AND let a "real" gravity
  // constant (9.8 m/s^2) cancel almost the entire kick's vertical velocity
  // in a single step, producing the "ball just hops a little" symptom.
  // `dt` is kept only as metadata (seconds represented by one cycle) for
  // real-time playback pacing in main.js — it does NOT appear in the
  // formulas below.
  step() {
    const p = this.params;
    const b = this.ball;
    const airborne = b.pos.z > 1e-6;
    // A ball already resting flat on the ground (settled by a previous bounce,
    // vel.z exactly 0) must NOT have gravity re-applied to it: gravity alone
    // (default 0.15) is bigger than bounce_stop_speed (default 0.05), so a
    // resting ball would "fall" 0.15/cycle, hit the settle check, bounce back
    // up at 0.15*restitution, then fall again — a perpetual micro-bounce that
    // never actually settles (verified via debug_trace.js: a grounder kick
    // bounces at ~0.06 forever instead of stopping). Skipping gravity while
    // already resting fixes this; any kick or external velocity change makes
    // vel.z non-zero again next cycle, so gravity resumes normally then.
    const resting = b.pos.z <= 0 && b.vel.z === 0;

    // Settle threshold used by BOTH bounce-resolution branches below — see
    // _bounceSettleThreshold()'s comment for why this is more than just
    // `p.bounce_stop_speed` (perpetual-bounce guard for high gravity/
    // restitution combos where the ball never gets a full cycle of hang time).
    const settleThreshold = this._bounceSettleThreshold();

    // gravity (z only) — per-cycle velocity loss, same unit scale as the kick's vz
    if (!resting) b.vel.z += -p.gravity;

    // integrate position — per-cycle, matching rcssserver's `pos += vel`
    const x0 = b.pos.x, y0 = b.pos.y; // pre-integration x/y, needed below to locate the true impact point
    b.pos.x += b.vel.x;
    b.pos.y += b.vel.y;

    // `bounced` tracks whether the precise-timing branch below already
    // resolved this cycle's ground collision (bounced vel.z/pos.z set) so
    // the existing post-hoc "ground collision / bounce" block further down
    // can skip re-processing it.
    let bounced = false;
    if (!resting) {
      const z0 = b.pos.z;
      const newZ = z0 + b.vel.z;
      if (p.precise_bounce_timing && z0 > 0 && newZ <= 0) {
        // EXPERIMENTAL "mirror" bounce (see precise_bounce_timing in
        // DEFAULT_PARAMS): find the fraction of THIS cycle at which pos.z
        // actually crosses 0 (linear interpolation - within one cycle the
        // ball moves at the constant post-gravity vel.z), bounce velocity
        // at that exact instant, then continue moving for the remaining
        // fraction of the cycle with the reflected velocity, instead of
        // jumping straight to z=0 and discarding the rest of the cycle's
        // fall/travel.
        const frac = z0 / (z0 - newZ); // 0..1, fraction of the cycle before impact
        const vzImpact = b.vel.z;      // velocity at the moment of impact

        // TRUE ground-contact point: vel.x/vel.y are constant across the whole
        // cycle (no horizontal force), so the ball's ACTUAL x/y at the instant
        // z crosses 0 is x0/y0 (pre-integration, captured above) advanced by
        // only the `frac` share of this cycle's horizontal motion — NOT the
        // full-cycle x/y already written into b.pos above. Without this, the
        // recorded trail sample for this cycle jumps straight to the
        // full-cycle x/y with a "mirrored" (partial-cycle) z, silently
        // skipping over the real (x,y,0) contact point in between — e.g. a
        // ball at (0,0,1) falling to a would-be (1,0,-0.25) doesn't actually
        // touch ground at x=1; it touches down around x=frac*1, and neither
        // trail sample on either side of the bounce cycle is ever placed
        // there. Attaching it to the event lets main.js plot that exact spot.
        const impact = { x: x0 + b.vel.x * frac, y: y0 + b.vel.y * frac, z: 0 };

        const candidate = -vzImpact * p.ball_bounce_restitution;
        if (Math.abs(candidate) < settleThreshold) {
          this._applyBounceEnergyLoss();
          b.vel.z = 0;
          b.pos.z = 0;
          if (airborne) this.events.push({ cycle: this.cycle, text: "Ball settled on ground.", impact });
        } else {
          // BUG FIX (v1 attempted, reverted): the naive version set
          // vel.z = candidate and coasted for the remaining fraction of the
          // cycle WITHOUT applying that fraction's share of gravity, which
          // conserved slightly too much energy and locked into an exact
          // non-decaying 2-cycle oscillation for the default params
          // (gravity=0.15, restitution=0.65, bounce_stop_speed=0.05) —
          // isAtRest() never became true. A first fix attempt subtracted a
          // full `gravity*remaining` from vel.z too, but that double-counts
          // decay on the VELOCITY carried into next cycle and made the
          // ball's fall diverge (vz blew up to -40+ instead of settling).
          //
          // Correct fix: keep vel.z assignment IDENTICAL to the non-precise
          // path (b.vel.z = candidate) so velocity accounting — and thus
          // isAtRest()/roll_stop_speed convergence — behaves exactly like
          // the proven-correct off-mode. Only the POSITION for the
          // remainder of the cycle is improved, using real kinematics
          // (pos = v*t - 1/2*g*t^2) instead of a straight-line
          // extrapolation, so the visible arc doesn't overshoot upward
          // unrealistically. This keeps the "no visible underground dip"
          // benefit of mirroring while preserving the same decay behavior
          // as the original clamp-to-zero model.
          const remaining = 1 - frac;
          this._applyBounceEnergyLoss();
          b.vel.z = candidate;
          b.pos.z = Math.max(0, candidate * remaining - 0.5 * p.gravity * remaining * remaining);
          this.events.push({ cycle: this.cycle, text: `Bounce! vz -> ${b.vel.z.toFixed(2)} (mirrored mid-step)`, impact });
        }
        bounced = true;

      } else {
        b.pos.z = newZ;
      }
    }


    // ground collision / bounce (skipped if the precise-timing branch above
    // already resolved this cycle's bounce, AND skipped entirely if the ball
    // was ALREADY resting flat before this cycle started - see `resting`
    // above). BUG FIX (2026-07-10): without the `!resting` guard, this block
    // used to fire on EVERY cycle a resting/rolling ball spends at pos.z<=0
    // (not just on a genuine new impact), because a resting ball never sets
    // `bounced=true` (that only happens in the airborne precise-timing branch,
    // itself skipped while resting). That meant `_applyBounceEnergyLoss()` -
    // which scales vx/vy by ball_bounce_restitution (0.5 default) - was being
    // applied EVERY cycle to a plain rolling grounder, on top of the normal
    // ball_decay friction, killing its speed almost instantly (a loft=0,
    // power=100 kick stopped after ~5 cycles at x~5m instead of the expected
    // ~40m). The old pre-merge `_applyBounceFriction()` avoided this by
    // internally gating on `normalImpulse > 0` (zero for a resting ball,
    // since vzImpact and postBounceVz were both 0) - that implicit guard was
    // lost when the two params were merged into a single unconditional scale.
    if (!resting && !bounced && b.pos.z <= 0) {
      b.pos.z = 0;
      // Check the PREDICTED post-bounce velocity against bounce_stop_speed,
      // not the incoming fall velocity. Checking the incoming velocity is
      // wrong whenever gravity > bounce_stop_speed (true for the defaults:
      // gravity=0.15, bounce_stop_speed=0.05): the incoming velocity then
      // converges to a stable ~gravity-sized value every cycle and NEVER
      // dips below the threshold, so the ball bounces forever at a fixed
      // tiny amplitude instead of settling (verified via debug_trace.js —
      // a loft kick used to bounce at a constant vz≈0.06 indefinitely).
      const vzImpact = b.vel.z;
      const candidate = -vzImpact * p.ball_bounce_restitution;
      if (Math.abs(candidate) < settleThreshold) {
        this._applyBounceEnergyLoss();
        b.vel.z = 0;
        if (airborne) this.events.push({ cycle: this.cycle, text: "Ball settled on ground." });
      } else {
        this._applyBounceEnergyLoss();
        b.vel.z = candidate;
        this.events.push({ cycle: this.cycle, text: `Bounce! vz -> ${b.vel.z.toFixed(2)}` });
      }
    }

    // xy friction: ONLY applies while the ball is on the ground. No air
    // friction at all now (air_decay param removed) - horizontal speed is
    // perfectly conserved while airborne; gravity governs z only.
    if (b.pos.z <= 1e-6) {
      b.vel.x *= p.ball_decay;
      b.vel.y *= p.ball_decay;
    }

    // Ground roll-stop: once a RESTING ball's horizontal speed decays below
    // roll_stop_speed, freeze it fully (vx=vy=0) instead of continuing to
    // simulate an effectively-motionless ball forever. This is separate from
    // bounce_stop_speed, which only governs the vertical bounce -> settle
    // transition (z). Only applies once the ball is actually resting on the
    // ground (z<=0 and vz already zeroed by the bounce logic above).
    if (b.pos.z <= 0 && b.vel.z === 0) {
      const speedXY = Math.sqrt(b.vel.x ** 2 + b.vel.y ** 2);
      if (speedXY > 0 && speedXY < p.roll_stop_speed) {
        b.vel.x = 0;
        b.vel.y = 0;
        this.events.push({ cycle: this.cycle, text: "Ball stopped rolling." });
      }
    }

    this.cycle += 1;
    this.time += CYCLE_DT;
    this.maxHeightReached = Math.max(this.maxHeightReached, b.pos.z);
    this.trail.push({ ...b.pos });
    if (this.trail.length > 2000) this.trail.shift();

    // If the Step scrubber bar was dragged BACK to an earlier cycle and the
    // sim is then stepped/played forward again, discard the stale "future"
    // history beyond that point before appending — otherwise history[idx]
    // would stop matching cycle idx once new states are appended past the
    // old array length, breaking gotoStep()'s direct index==cycle mapping.
    if (this.history.length > this.cycle) this.history.length = this.cycle;
    this.history.push(this._snapshot());
  }

  speed() {
    const v = this.ball.vel;
    return Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
  }

  // True once the ball has fully settled: resting on the ground (z<=0) AND
  // every velocity component has been zeroed out by the bounce-settle /
  // roll_stop_speed logic in step() (both zero it out EXACTLY, not just
  // "below a threshold" — so this check is exact, no epsilon needed). Used
  // by main.js to auto-stop playback once there's nothing left to animate.
  isAtRest() {
    const v = this.ball.vel;
    return this.ball.pos.z <= 0 && v.x === 0 && v.y === 0 && v.z === 0;
  }
}

// exposed globally (plain <script>, no bundler needed) — and to Node (module.exports)
// so a headless debug harness (see debug_trace.js) can drive the exact same physics
// and write a step-by-step log to disk for troubleshooting.
if (typeof window !== "undefined") {
  window.KickLabPhysics = KickLabPhysics;
  window.DEFAULT_PARAMS = DEFAULT_PARAMS;
  window.CYCLE_DT = CYCLE_DT;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { KickLabPhysics, DEFAULT_PARAMS, CYCLE_DT };
}
