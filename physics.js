/*
 * physics.js — 3D kick / ball-flight physics lab
 *
 * Implements the "Option C" (ball fully 3D, player flat + reach height)
 * extension formula discussed for rcssserver:
 *
 *   eff_power   = power * kick_power_rate
 *               * (1 - 0.25*dir_diff/PI - 0.25*dist_ball/kickable_margin)
 *   eff_power  *= (1 - loft_power_cost * (loft/90deg))     // loft "costs" power
 *   horiz       = eff_power * cos(loft)
 *   vert        = eff_power * sin(loft)
 *   accel_xy    = polar(horiz, dir_rel + body_angle)
 *   accel_z     = vert
 *
 * Per-cycle integration (dt seconds per cycle, default 0.1s like rcssserver):
 *   vz   += -gravity * dt
 *   pos  += vel * dt
 *   if pos.z <= 0: pos.z = 0; vz = -vz * restitution; (settle if too slow)
 *   vx,vy *= (airborne ? air_decay : ball_decay)     // xy friction, gravity handles z
 *
 * All state/formulas are intentionally kept in ONE plain object graph
 * (no framework) so they are easy to read, tweak, and port back into
 * rcssserver's C++ (object.cpp / player.cpp) later.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

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
  gravity: 0.15,
  ball_bounce_restitution: 0.65,
  loft_power_cost: 0.4,     // fraction of power "spent" lifting the ball at 90 deg loft
  air_decay: 0.999,         // xy friction while ball is AIRBORNE (near-zero air resistance)
  bounce_stop_speed: 0.05,  // |vz| below this on a ground touch => ball settles (z=0,vz=0)
  roll_stop_speed: 0.05,    // horizontal (xy) speed below this WHILE RESTING ON GROUND => ball freezes (vx=vy=0)
  player_height: 2.0,       // cylinder height (m) - visual + "can this player head the ball" band

  player_reach_height: 2.0, // max z at which a player can play/kick an airborne ball
  height_power_cost: 0.25,  // NEW: fraction of effPower lost as ball.z approaches player_reach_height
                            // (mirrors the existing 0.25 weight already used for dirDiff/distBall below —
                            // previously ball height had ZERO effect on power, only a binary reach cutoff)

  dt: 0.1,                  // seconds simulated per "cycle" (matches rcssserver's 100ms cycle)
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
    const inReach = this.ball.pos.z <= this.params.player_reach_height;
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
    // reach-height cutoff). Previously ball.z had NO effect on effPower at
    // all — only a binary isBallKickable() cutoff at player_reach_height, so
    // a header at head height cost exactly the same power as a grounder at
    // the player's feet. This mirrors the existing distBall/dirDiff terms so
    // a higher ball is now progressively harder to strike with full power,
    // same idea as being off-angle or at the edge of kickable_margin.
    const heightFrac = p.player_reach_height > 0
      ? Math.max(0, this.ball.pos.z) / p.player_reach_height
      : 0;

    let effPower = power * p.kick_power_rate *
      (1 - 0.25 * dirDiff / Math.PI
         - 0.25 * Math.max(0, distBall) / p.kickable_margin
         - p.height_power_cost * heightFrac);
    effPower = Math.max(0, effPower);

    // Loft costs power (your idea: kicking upward reduces available push)
    const effPowerTotal = effPower * (1 - p.loft_power_cost * (loft / (Math.PI / 2)));

    const horiz = effPowerTotal * Math.cos(loft);
    const vert = effPowerTotal * Math.sin(loft);

    const kickAngle = dir + this.player.bodyAngle;
    let accelX = horiz * Math.cos(kickAngle);
    let accelY = horiz * Math.sin(kickAngle);
    let accelZ = vert;

    // optional small kick noise (rcssserver-style), off by default (ball_rand=0)
    if (p.ball_rand > 0) {
      const maxRand = p.ball_rand * (power / p.max_power) * effPowerTotal;
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
      effPowerTotal,
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

    // gravity (z only) — per-cycle velocity loss, same unit scale as the kick's vz
    if (!resting) b.vel.z += -p.gravity;

    // integrate position — per-cycle, matching rcssserver's `pos += vel`
    b.pos.x += b.vel.x;
    b.pos.y += b.vel.y;
    if (!resting) b.pos.z += b.vel.z;

    // ground collision / bounce
    if (b.pos.z <= 0) {
      b.pos.z = 0;
      // Check the PREDICTED post-bounce velocity against bounce_stop_speed,
      // not the incoming fall velocity. Checking the incoming velocity is
      // wrong whenever gravity > bounce_stop_speed (true for the defaults:
      // gravity=0.15, bounce_stop_speed=0.05): the incoming velocity then
      // converges to a stable ~gravity-sized value every cycle and NEVER
      // dips below the threshold, so the ball bounces forever at a fixed
      // tiny amplitude instead of settling (verified via debug_trace.js —
      // a loft kick used to bounce at a constant vz≈0.06 indefinitely).
      const candidate = -b.vel.z * p.ball_bounce_restitution;
      if (Math.abs(candidate) < p.bounce_stop_speed) {
        b.vel.z = 0;
        if (airborne) this.events.push({ cycle: this.cycle, text: "Ball settled on ground." });
      } else {
        b.vel.z = candidate;
        this.events.push({ cycle: this.cycle, text: `Bounce! vz -> ${b.vel.z.toFixed(2)}` });
      }
    }

    // xy friction: ground decay vs (near-zero) air decay
    const decay = b.pos.z > 1e-6 ? p.air_decay : p.ball_decay;
    b.vel.x *= decay;
    b.vel.y *= decay;

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
    this.time += p.dt;
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
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { KickLabPhysics, DEFAULT_PARAMS };
}
