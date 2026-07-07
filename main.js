/*
 * main.js — Three.js scene + UI wiring for the 3D Kick Lab.
 * Coordinate mapping: physics(x,y,z) -> three(x, z, y)
 *   physics x,y = ground plane, physics z = height (up)
 *   three.js x,z = ground plane, three.js y = height (up, default three convention)
 */

(function () {
  const params = { ...window.DEFAULT_PARAMS };
  const sim = new window.KickLabPhysics(params);

  // ---------------- Three.js scene setup ----------------
  const viewport = document.getElementById("viewport");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151a);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
  // pulled back further and raised to see the whole real-size (105x68) pitch by default.
  // Looking further down-field (+x) than the origin (see controls.target below) shifts
  // the origin/player toward the LEFT of the viewport instead of dead-center, leaving
  // more visible room on the right for the ball and its kicked flight path.
  camera.position.set(21, 12, 22);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  viewport.appendChild(renderer.domElement);

  function resize() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  // Aim further down-field (x=16) than the player's origin (x=0) — this is what
  // pushes the origin/player toward the left side of the frame (see camera comment above).
  controls.target.set(16, 1, 0);
  controls.update();

  // lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(8, 12, 6);
  scene.add(sun);

  // field (pitch) - real rcssserver dimensions: PITCH_LENGTH=105, PITCH_WIDTH=68
  // (see serverparam.cpp) so a goal at "52.5 from center" is exactly the pitch's
  // own half-length, not an arbitrary number. Field is centered on the origin,
  // matching rcssserver's coordinate convention (field center = (0,0)).
  const fieldW = 105, fieldH = 68;
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(fieldW, fieldH),
    new THREE.MeshStandardMaterial({ color: 0x2c6e3f, side: THREE.DoubleSide })
  );
  field.rotation.x = -Math.PI / 2;
  field.position.set(0, 0, 0);
  scene.add(field);

  const grid = new THREE.GridHelper(fieldW, fieldW / 5, 0x4c8a5e, 0x3a7a4d);
  grid.position.copy(field.position);
  grid.position.y = 0.001;
  scene.add(grid);

  // ---------------- Field x/y axis number labels (DOM overlay) ----------------
  // Field spans physics x in [field.position.x - fieldW/2, field.position.x + fieldW/2]
  // and physics y in [-fieldH/2, fieldH/2] (three.js z axis). We stamp tick labels
  // along the two near edges so the ground plane has visible x/y coordinates.
  const labelLayer = document.getElementById("labelLayer");
  const fieldMinX = field.position.x - fieldW / 2;
  const fieldMaxX = field.position.x + fieldW / 2;
  const fieldMinY = -fieldH / 2;
  const fieldMaxY = fieldH / 2;

  const axisLabels = []; // { el, worldPos: THREE.Vector3 }
  function addAxisLabel(physX, physY, text, extraClass) {
    const el = document.createElement("div");
    el.className = extraClass ? `axisLabel ${extraClass}` : "axisLabel";
    el.textContent = text;
    labelLayer.appendChild(el);
    axisLabels.push({ el, worldPos: new THREE.Vector3(physX, 0.05, physY) });
  }
  // x ticks along the y = fieldMinY edge (every 10 units on this real-size 105m pitch)
  const TICK_STEP = 10;
  for (let x = Math.ceil(fieldMinX / TICK_STEP) * TICK_STEP; x <= fieldMaxX; x += TICK_STEP) {
    addAxisLabel(x, fieldMinY, `x=${x}`);
  }
  // y ticks along the x = fieldMinX edge
  for (let y = Math.ceil(fieldMinY / TICK_STEP) * TICK_STEP; y <= fieldMaxY; y += TICK_STEP) {
    if (y === 0) continue; // avoid overlapping the x=... label at the origin corner
    addAxisLabel(fieldMinX, y, `y=${y}`);
  }
  // Origin sits exactly at the player's base (0,0), so its label would
  // otherwise overlap the player/ball — nudge it to the left via a
  // dedicated CSS class instead of centering it on the anchor point.
  addAxisLabel(0, 0, "origin (0,0)", "originLabel");
  // explicit goal-line markers (52.5 = rcssserver's own PITCH_LENGTH/2)
  addAxisLabel(52.5, fieldMinY, "x=52.5 (goal)");
  addAxisLabel(-52.5, fieldMinY, "x=-52.5 (goal)");

  function worldToScreen(vec3) {
    const v = vec3.clone().project(camera);
    const w = viewport.clientWidth, h = viewport.clientHeight;
    return {
      x: (v.x * 0.5 + 0.5) * w,
      y: (-(v.y * 0.5) + 0.5) * h,
      behind: v.z > 1,
    };
  }

  function updateAxisLabels() {
    for (const { el, worldPos } of axisLabels) {
      const s = worldToScreen(worldPos);
      el.style.display = s.behind ? "none" : "block";
      el.style.left = s.x + "px";
      el.style.top = s.y + "px";
    }
  }

  // ---------------- Mouse-hover ground coordinate readout ----------------
  const raycaster = new THREE.Raycaster();
  const mouseNDC = new THREE.Vector2();
  const mouseCoordEl = document.getElementById("mouseCoordLabel");
  let mouseClientPos = null;

  renderer.domElement.addEventListener("pointermove", (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    mouseClientPos = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    mouseClientPos = null;
    mouseCoordEl.style.display = "none";
  });

  function updateMouseCoordLabel() {
    if (!mouseClientPos) return;
    raycaster.setFromCamera(mouseNDC, camera);
    const hit = raycaster.intersectObject(field, false);
    if (hit.length > 0) {
      const p = hit[0].point; // three.js coords: x,z = ground plane, y = height
      mouseCoordEl.textContent = `x=${p.x.toFixed(2)}, y=${p.z.toFixed(2)}`;
      mouseCoordEl.style.display = "block";
      mouseCoordEl.style.left = mouseClientPos.x + "px";
      mouseCoordEl.style.top = mouseClientPos.y + "px";
    } else {
      mouseCoordEl.style.display = "none";
    }
  }

  // goal (simple frame) placed down-field along +x
  function buildGoal(xPos, goalWidth, goalHeight) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2 });
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, goalHeight, 12);
    const postL = new THREE.Mesh(postGeo, mat);
    postL.position.set(xPos, goalHeight / 2, -goalWidth / 2);
    const postR = postL.clone();
    postR.position.z = goalWidth / 2;
    const barGeo = new THREE.CylinderGeometry(0.06, 0.06, goalWidth, 12);
    const bar = new THREE.Mesh(barGeo, mat);
    // Cylinder's default axis is Y. The crossbar must span the Z axis (it connects
    // postL/postR, which sit at z=-goalWidth/2 and z=+goalWidth/2). Rotating about Z
    // maps the Y-axis onto X (wrong — that was the "90 deg off" bug). Rotating about
    // X maps the Y-axis onto Z, which is what we need.
    bar.rotation.x = Math.PI / 2;
    bar.position.set(xPos, goalHeight, 0);
    group.add(postL, postR, bar);
    return group;
  }
  // GOAL_X = 52.5 = rcssserver's ServerParam PITCH_LENGTH/2 (serverparam.cpp:132,
  // PITCH_LENGTH=105.0) — the goal line sits exactly at half the pitch length from
  // the center (0,0), same as the real server's field geometry. Both goals are
  // drawn (attacking +x goal and the mirrored own goal at -x) for a complete pitch.
  const GOAL_X = 52.5, GOAL_WIDTH = 7.32, GOAL_HEIGHT = 2.44; // real-world-ish meters
  scene.add(buildGoal(GOAL_X, GOAL_WIDTH, GOAL_HEIGHT));
  scene.add(buildGoal(-GOAL_X, GOAL_WIDTH, GOAL_HEIGHT));

  // player cylinder, fixed at origin, height 2m
  const player = new THREE.Mesh(
    new THREE.CylinderGeometry(params.player_size, params.player_size, params.player_height, 20),
    new THREE.MeshStandardMaterial({ color: 0x3f7fdb })
  );
  player.position.set(0, params.player_height / 2, 0);
  scene.add(player);

  // facing indicator (arrow along +x, the player's body angle)
  const facing = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.05, 0), 1.2, 0xffcc33, 0.25, 0.15);
  scene.add(facing);

  // ball
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(params.ball_size, 0.08), 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  );
  scene.add(ball);

  // trail line + point markers
  //
  // FIX for "can't see the trail from some camera angles": a plain THREE.Line at
  // y=0 sits exactly co-planar with the field (also at y=0) and grid (y=0.001) -
  // from grazing/top-down angles, floating-point depth precision makes the trail
  // flicker behind the ground ("z-fighting"), and a 1px line is easy to lose
  // regardless of angle since WebGL ignores CSS-style linewidth on most
  // platforms. Fix: (1) lift the whole trail slightly off the ground, (2)
  // disable depth-testing with a high renderOrder so it always draws ON TOP of
  // the field/grid instead of fighting with them, and (3) add small always-size
  // point markers along the trail (easier to spot than a thin line from any
  // viewing angle, especially end-on).
  const MAX_TRAIL = 600;
  const TRAIL_LIFT = 0.04; // world units raised above the true ball height, visual-only
  const trailGeom = new THREE.BufferGeometry();
  const trailPositions = new Float32Array(MAX_TRAIL * 3);
  trailGeom.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeom.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({ color: 0xffd25a, depthTest: false });
  const trailLine = new THREE.Line(trailGeom, trailMat);
  trailLine.renderOrder = 998;
  // BUG FIX ("live trail vanishes on zoom, saved-run trails don't"): a saved
  // run's compare-trail geometry is built ONCE with its final, complete
  // position data, so Three.js's automatic (one-time, lazy) boundingSphere
  // computation on first render is already correct forever. The LIVE trail's
  // geometry, by contrast, is mutated every frame in refreshTrailMesh() below
  // (positions rewritten + drawRange grown) WITHOUT ever recomputing
  // boundingSphere - so frustum-culling keeps testing against the stale
  // (tiny/near-origin) sphere from the very first render, and once the camera
  // (zoom) moves enough that the frustum no longer overlaps that stale
  // sphere, Three.js culls the whole object even though the actual
  // trail/ball position is still clearly on-screen. Disabling frustumCulled
  // on these two ALWAYS-DYNAMIC objects sidesteps the stale-bounding-sphere
  // problem entirely (cheap for a single line/point-cloud like this).
  trailLine.frustumCulled = false;
  scene.add(trailLine);

  const trailPointsMat = new THREE.PointsMaterial({
    color: 0xffa800,
    size: 0.18,
    sizeAttenuation: true,
    depthTest: false,
  });
  const trailPoints = new THREE.Points(trailGeom, trailPointsMat);
  trailPoints.renderOrder = 999;
  trailPoints.frustumCulled = false; // see trailLine.frustumCulled comment above
  scene.add(trailPoints);

  function physToThree(p) {
    return new THREE.Vector3(p.x, p.z, p.y);
  }

  function refreshTrailMesh() {
    const t = sim.trail;
    const n = Math.min(t.length, MAX_TRAIL);
    const start = t.length - n;
    for (let i = 0; i < n; i++) {
      const v = physToThree(t[start + i]);
      trailPositions[i * 3] = v.x;
      trailPositions[i * 3 + 1] = v.y + TRAIL_LIFT; // lift ONLY the trail visual, not the ball itself
      trailPositions[i * 3 + 2] = v.z;
    }
    trailGeom.setDrawRange(0, n);
    trailGeom.attributes.position.needsUpdate = true;
  }

  // Bounce markers: with precise_bounce_timing=ON, physics.js's step() only
  // records ONE trail sample per cycle - the position AFTER a full cycle of
  // x/y motion, paired with a z value "mirrored" for just the fractional
  // remainder of the cycle after impact. That recorded sample is NOT where
  // the ball actually touched the ground: the real (analytic) contact point
  // is x0/y0 advanced by only the impact-fraction share of the cycle, at
  // z=0 exactly - a distinct location the trail line skips over entirely
  // (see physics.js step()'s `impact` field + its derivation comment).
  // These markers plot that true, otherwise-invisible ground-contact point.
  const MAX_BOUNCE_MARKERS = 200;

  const bounceGeom = new THREE.BufferGeometry();
  const bouncePositions = new Float32Array(MAX_BOUNCE_MARKERS * 3);
  bounceGeom.setAttribute("position", new THREE.BufferAttribute(bouncePositions, 3));
  bounceGeom.setDrawRange(0, 0);
  const bounceMat = new THREE.PointsMaterial({
    color: 0xff2d2d,
    size: 0.34,
    sizeAttenuation: true,
    depthTest: false,
  });
  const bouncePoints = new THREE.Points(bounceGeom, bounceMat);
  // renderOrder is LOWER than trailLine (998) and trailPoints (999) on purpose:
  // with depthTest:false, draw order is decided purely by renderOrder, so a
  // bounce marker sitting at (or very near) the same spot as a trail point/line
  // segment must always be painted UNDERNEATH its orange neighbors, not on top
  // of them - otherwise the bigger red square visually floats in front of/above
  // the trajectory line instead of looking like a point ON it.
  bouncePoints.renderOrder = 997;
  bouncePoints.frustumCulled = false; // same dynamic-geometry fix as trailLine/trailPoints above
  scene.add(bouncePoints);

  function refreshBounceMarkers() {
    // Bounce events are pushed with `cycle: this.cycle` BEFORE the cycle
    // counter is incremented (see physics.js step()) - an event "took effect"
    // once sim.cycle has advanced past event.cycle, so gating on
    // `e.cycle < sim.cycle` keeps markers scrub-safe: they vanish/reappear
    // correctly when dragging the Step bar backward/forward, exactly like
    // the trail/history arrays already do.
    //
    // Only precise-timing bounce/settle events carry `impact` (the analytic
    // true ground-contact point - see physics.js step()'s `impact` comment);
    // plot that instead of the recorded (mirrored) trail sample, since the
    // recorded sample sits at a different x/y than where the ball really hit.
    const markers = [];
    for (const e of sim.events) {
      if (!e.impact) continue;
      if (e.cycle >= sim.cycle) continue; // not reached yet (e.g. scrubbed back)
      markers.push(e.impact);
    }
    const n = Math.min(markers.length, MAX_BOUNCE_MARKERS);
    const start = markers.length - n;
    for (let i = 0; i < n; i++) {
      const v = physToThree(markers[start + i]);
      bouncePositions[i * 3] = v.x;
      bouncePositions[i * 3 + 1] = v.y + TRAIL_LIFT;
      bouncePositions[i * 3 + 2] = v.z;
    }
    bounceGeom.setDrawRange(0, n);
    bounceGeom.attributes.position.needsUpdate = true;
  }



  function syncMeshes() {
    const v = physToThree(sim.ball.pos);
    ball.position.set(v.x, v.y + params.ball_size, v.z);
    refreshTrailMesh();
    refreshBounceMarkers();
  }

  // ---------------- UI wiring ----------------
  const $ = (id) => document.getElementById(id);

  function fmtVec(v, digits = 2) {
    return `${v.x.toFixed(digits)}, ${v.y.toFixed(digits)}, ${v.z.toFixed(digits)}`;
  }

  function updateReadouts() {
    $("roCycle").textContent = sim.cycle;
    $("roTime").textContent = sim.time.toFixed(2);
    $("roPos").textContent = fmtVec(sim.ball.pos);
    $("roVel").textContent = fmtVec(sim.ball.vel);
    $("roSpeed").textContent = sim.speed().toFixed(3);
    $("roMaxH").textContent = sim.maxHeightReached.toFixed(3);
    const kEl = $("roKickable");
    const kickable = sim.isBallKickable();
    kEl.textContent = "Kickable: " + (kickable ? "YES" : "no");
    kEl.className = "kickable " + (kickable ? "ok" : "bad");
  }

  function updateEventLog() {
    const el = $("eventLog");
    const recent = sim.events.slice(-40);
    el.innerHTML = recent.map((e) => `<div>[${e.cycle}] ${e.text}</div>`).join("");
    el.scrollTop = el.scrollHeight;
  }

  const ballCoordEl = document.getElementById("ballCoordLabel");
  function updateBallCoordLabel() {
    const s = worldToScreen(ball.position);
    ballCoordEl.style.display = s.behind ? "none" : "block";
    ballCoordEl.style.left = s.x + "px";
    ballCoordEl.style.top = s.y + "px";
    const p = sim.ball.pos;
    ballCoordEl.textContent = `x=${p.x.toFixed(2)}, y=${p.y.toFixed(2)}, z=${p.z.toFixed(2)}`;
  }

  // ---------------- Step scrubber (timeline bar) ----------------
  // Backed by sim.history (full pos+vel snapshot per cycle, see physics.js).
  // Dragging it jumps directly to that cycle (no re-simulation); Step/Play
  // keep working exactly as before and simply advance sim.cycle, which this
  // syncs back onto the bar every frame.
  const stepSlider = $("stepScrubber");
  const stepLabelEl = $("stepLabel");

  stepSlider.oninput = () => {
    stopPlaying();
    sim.gotoStep(parseInt(stepSlider.value, 10));
    renderFrame();
    updateEventLog();
  };

  function syncStepScrubber() {
    const maxIdx = Math.max(0, sim.history.length - 1);
    stepSlider.max = maxIdx;
    stepSlider.value = sim.cycle;
    stepLabelEl.textContent = `${sim.cycle} / ${maxIdx}`;
  }

  function renderFrame() {
    syncMeshes();
    updateReadouts();
    updateAxisLabels();
    updateMouseCoordLabel();
    updateBallCoordLabel();
    syncStepScrubber();
    renderer.render(scene, camera);
  }

  // Step / Play / Pause / Reset
  let playing = false;
  let lastWall = 0;
  let accum = 0;

  function doStep() {
    sim.step();
    renderFrame();
    updateEventLog();
  }

  function doReset() {
    const overrides = {
      x: parseFloat($("init_x").value) || undefined,
      y: parseFloat($("init_y").value) || 0,
      z: parseFloat($("init_z").value) || 0,
      vx: parseFloat($("init_vx").value) || 0,
      vy: parseFloat($("init_vy").value) || 0,
      vz: parseFloat($("init_vz").value) || 0,
    };
    sim.reset(overrides);
    $("kickInfo").textContent = "No kick yet.";
    renderFrame();
    updateEventLog();
  }

  $("btnStep").onclick = () => { stopPlaying(); doStep(); };
  $("btnReset").onclick = () => { stopPlaying(); doReset(); };

  // "Ground View (z=0)" - snaps the camera down to just above the field plane
  // and centers on the ball's CURRENT position, so bounce points (including
  // the red off-ground bounce markers above) can be eyeballed almost edge-on
  // against the field grid to check how close to z=0 they really land.
  // Re-clicking after stepping/playing further re-centers on the ball's new
  // position - it is a one-shot snap, not a locked/tracking camera mode, so
  // OrbitControls dragging afterwards behaves exactly as it does everywhere else.
  $("btnGroundView").onclick = () => {
    const v = physToThree(sim.ball.pos);
    const eyeHeight = 0.15; // just above the field mesh (y=0) to avoid clipping into it
    camera.position.set(v.x, eyeHeight, v.z + 14);
    controls.target.set(v.x, eyeHeight, v.z);
    controls.update();
  };

  function stopPlaying() {
    playing = false;
    $("btnPlay").disabled = false;
    $("btnPause").disabled = true;
  }

  $("btnPlay").onclick = () => {
    playing = true;
    lastWall = performance.now();
    accum = 0;
    $("btnPlay").disabled = true;
    $("btnPause").disabled = false;
  };
  $("btnPause").onclick = stopPlaying;

  const speedSlider = $("speed");
  speedSlider.oninput = () => { $("speedVal").textContent = parseFloat(speedSlider.value).toFixed(2) + "x"; };

  $("btnKick").onclick = () => {
    const power = parseFloat($("power").value);
    const dir = parseFloat($("dir").value);
    const loft = parseFloat($("loft").value);
    const info = sim.kick(power, dir, loft);
    if (info.ok) {
      $("kickInfo").innerHTML =
        `dir_diff=${info.dirDiffDeg.toFixed(1)}°, dist_ball=${info.distBall.toFixed(3)}, height_frac=${info.heightFrac.toFixed(3)}, ` +
        `eff_power=${info.effPower.toFixed(3)}, eff_power(loft-adj)=${info.effPowerTotal.toFixed(3)}<br/>` +
        `accel = (${info.accel.x.toFixed(2)}, ${info.accel.y.toFixed(2)}, ${info.accel.z.toFixed(2)})`;
    } else {
      $("kickInfo").textContent = info.reason;
    }
    updateEventLog();
    // Auto-start playback so the kick's effect is immediately visible instead
    // of requiring a separate manual Play click. Step/Play/Pause/the scrubber
    // bar all still work exactly as before once playback is running.
    if (info.ok && !playing) $("btnPlay").onclick();
  };

  // Export a full trace (params + trail + events) as a downloadable JSON file
  // so you can inspect exactly what happened cycle-by-cycle, or share it for
  // debugging — mirrors what debug_trace.js writes to logs/ under Node.
  $("btnExportLog").onclick = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      params: sim.params,
      lastKickInfo: sim.lastKickInfo,
      cycle: sim.cycle,
      time: sim.time,
      maxHeightReached: sim.maxHeightReached,
      trail: sim.trail,
      events: sim.events,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kicklab_trace_${sim.cycle}cycles_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  ["power", "dir", "loft"].forEach((id) => {
    const el = $(id);
    el.oninput = () => { $(id + "Val").textContent = el.value; };
  });

  // ---------------- Saved runs (compare) ----------------
  // Persisted to localStorage so runs survive a page reload. Each saved run
  // snapshots everything needed to (a) redraw its trajectory in a distinct
  // color without re-simulating, and (b) restore/apply its exact params back
  // onto the live sliders. Storage is per-browser only (no server) — "clear
  // all" is the "clear db" the user asked for.
  const SAVED_RUNS_KEY = "kicklab_saved_runs_v1";
  const RUN_COLORS = [
    0xff5a5a, 0x5ad1ff, 0xffd25a, 0x8dff5a, 0xc77aff,
    0xff8f4d, 0x4dffc7, 0xff4dc7, 0xa0ff4d, 0x4d8fff,
  ];
  const runColorHex = (n) => "#" + n.toString(16).padStart(6, "0");

  function loadSavedRuns() {
    try {
      const raw = localStorage.getItem(SAVED_RUNS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn("Failed to load saved runs from localStorage:", e);
      return [];
    }
  }
  function persistSavedRuns(list) {
    try {
      localStorage.setItem(SAVED_RUNS_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn("Failed to persist saved runs to localStorage:", e);
    }
  }

  let savedRuns = loadSavedRuns();
  // id -> { line, points, geom } for currently-checked (rendered) compare trails
  const compareTrails = new Map();

  function buildCompareTrail(run) {
    const n = run.trail.length;
    if (n < 1) return;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = physToThree(run.trail[i]);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y + TRAIL_LIFT;
      positions[i * 3 + 2] = v.z;
    }
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const lineMat = new THREE.LineBasicMaterial({ color: run.color, depthTest: false });
    const line = new THREE.Line(geom, lineMat);
    line.renderOrder = 500;
    scene.add(line);

    const pointsMat = new THREE.PointsMaterial({ color: run.color, size: 0.14, sizeAttenuation: true, depthTest: false });
    const points = new THREE.Points(geom, pointsMat);
    points.renderOrder = 501;
    scene.add(points);

    compareTrails.set(run.id, { line, points, geom, lineMat, pointsMat });
  }

  function removeCompareTrail(id) {
    const entry = compareTrails.get(id);
    if (!entry) return;
    scene.remove(entry.line);
    scene.remove(entry.points);
    entry.geom.dispose();
    entry.lineMat.dispose();
    entry.pointsMat.dispose();
    compareTrails.delete(id);
  }

  function fmtParamsBlock(run) {
    const lines = [];
    lines.push(`kick: power=${run.kick.power}, dir=${run.kick.dir}, loft=${run.kick.loft}`);
    lines.push(`init: x=${run.init.x}, y=${run.init.y}, z=${run.init.z}, vx=${run.init.vx}, vy=${run.init.vy}, vz=${run.init.vz}`);
    lines.push("params:");
    Object.keys(run.params).sort().forEach((k) => lines.push(`  ${k} = ${run.params[k]}`));
    return lines.join("\n");
  }

  function applyRunParams(run) {
    // Kick command sliders
    $("power").value = run.kick.power; $("power").dispatchEvent(new Event("input", { bubbles: true }));
    $("dir").value = run.kick.dir; $("dir").dispatchEvent(new Event("input", { bubbles: true }));
    $("loft").value = run.kick.loft; $("loft").dispatchEvent(new Event("input", { bubbles: true }));
    // Ball initial state
    $("init_x").value = run.init.x;
    $("init_y").value = run.init.y;
    $("init_z").value = run.init.z;
    $("init_vx").value = run.init.vx;
    $("init_vy").value = run.init.vy;
    $("init_vz").value = run.init.vz;
    // Physics parameters — drive every matching slider/checkbox via resettableInputs
    // so PARAM_RANGES sliders, BOOL_PARAMS checkboxes, and their value labels/sim.params all stay in sync.
    resettableInputs.forEach(({ input, isCheckbox }) => {
      const key = input.id;
      if (!(key in run.params)) return;
      if (isCheckbox) input.checked = !!run.params[key]; else input.value = run.params[key];
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function deleteRun(id) {
    removeCompareTrail(id);
    savedRuns = savedRuns.filter((r) => r.id !== id);
    persistSavedRuns(savedRuns);
    renderSavedRunsList();
  }

  function renderSavedRunsList() {
    const host = $("savedRunsList");
    host.innerHTML = "";
    if (savedRuns.length === 0) {
      const empty = document.createElement("div");
      empty.className = "savedRunsEmpty";
      empty.textContent = "No saved runs yet — hit \"Save current run\" after a kick to compare it later.";
      host.appendChild(empty);
      return;
    }
    savedRuns.forEach((run) => {
      const item = document.createElement("div");
      item.className = "savedRunItem";

      const row = document.createElement("div");
      row.className = "savedRunRow";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = compareTrails.has(run.id);
      checkbox.onchange = () => {
        if (checkbox.checked) buildCompareTrail(run); else removeCompareTrail(run.id);
      };
      row.appendChild(checkbox);

      const swatch = document.createElement("span");
      swatch.className = "savedRunSwatch";
      swatch.style.background = runColorHex(run.color);
      row.appendChild(swatch);

      const meta = document.createElement("span");
      meta.className = "savedRunMeta";
      meta.title = run.name;
      meta.innerHTML = `${run.name}<span class="savedRunTime">${new Date(run.savedAt).toLocaleString()}</span>`;
      row.appendChild(meta);

      const btnGroup = document.createElement("span");
      btnGroup.className = "savedRunButtons";

      const paramsBtn = document.createElement("button");
      paramsBtn.className = "infoBtn";
      paramsBtn.type = "button";
      paramsBtn.textContent = "params";
      paramsBtn.title = "Show saved params for this run";
      btnGroup.appendChild(paramsBtn);

      const applyBtn = document.createElement("button");
      applyBtn.className = "infoBtn";
      applyBtn.type = "button";
      applyBtn.textContent = "apply";
      applyBtn.title = "Load this run's params into the current sliders";
      applyBtn.onclick = () => applyRunParams(run);
      btnGroup.appendChild(applyBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "infoBtn resetBtn";
      delBtn.type = "button";
      delBtn.textContent = "✕";
      delBtn.title = "Delete this saved run";
      delBtn.onclick = () => deleteRun(run.id);
      btnGroup.appendChild(delBtn);

      row.appendChild(btnGroup);
      item.appendChild(row);

      const paramsBlock = document.createElement("div");
      paramsBlock.className = "savedRunParams";
      paramsBlock.textContent = fmtParamsBlock(run);
      item.appendChild(paramsBlock);
      paramsBtn.onclick = () => {
        const open = paramsBlock.classList.toggle("open");
        paramsBtn.classList.toggle("active", open);
      };

      host.appendChild(item);
    });
  }

  $("btnSaveRun").onclick = () => {
    const n = savedRuns.length + 1;
    const kick = { power: parseFloat($("power").value), dir: parseFloat($("dir").value), loft: parseFloat($("loft").value) };
    const run = {
      id: (crypto.randomUUID ? crypto.randomUUID() : `run_${Date.now()}_${Math.random().toString(36).slice(2)}`),
      name: `Run ${n} — P${kick.power} D${kick.dir} L${kick.loft} (${sim.cycle} cyc)`,
      savedAt: new Date().toISOString(),
      color: RUN_COLORS[savedRuns.length % RUN_COLORS.length],
      cycle: sim.cycle,
      time: sim.time,
      maxHeightReached: sim.maxHeightReached,
      trail: sim.trail.map((p) => ({ ...p })),
      params: { ...sim.params },
      kick,
      init: {
        x: parseFloat($("init_x").value) || 0,
        y: parseFloat($("init_y").value) || 0,
        z: parseFloat($("init_z").value) || 0,
        vx: parseFloat($("init_vx").value) || 0,
        vy: parseFloat($("init_vy").value) || 0,
        vz: parseFloat($("init_vz").value) || 0,
      },
    };
    savedRuns.push(run);
    persistSavedRuns(savedRuns);
    renderSavedRunsList();
  };

  $("btnUncheckAllRuns").onclick = () => {
    Array.from(compareTrails.keys()).forEach(removeCompareTrail);
    renderSavedRunsList();
  };

  $("btnClearAllRuns").onclick = () => {
    if (savedRuns.length === 0) return;
    if (!confirm(`Delete all ${savedRuns.length} saved run(s)? This cannot be undone.`)) return;
    Array.from(compareTrails.keys()).forEach(removeCompareTrail);
    savedRuns = [];
    persistSavedRuns(savedRuns);
    renderSavedRunsList();
  };

  renderSavedRunsList();

  // ---- "!" info buttons: click to reveal a short explanation of what a
  // variable does and how changing it affects the simulation. ----
  const DESCRIPTIONS = {
    power: "Kick strength you command (0-100), same as rcssserver's kick power. Goes into eff_power = power * kick_power_rate * (alignment/distance penalties). Higher power -> larger eff_power -> both the horizontal AND vertical exit speed scale up together (split by loft below). Does NOT by itself change direction or arc shape.",
    dir: "Kick direction in degrees, RELATIVE to the player's body facing (0 = straight ahead, matches rcssserver's body-relative 'dir' convention). Only rotates the horizontal (x,y) direction of the kick - has no effect on loft/height or on speed.",
    loft: "Elevation angle of the kick: 0 deg = pure grounder (identical to today's rcssserver kick), 90 deg = straight up. eff_power is split into horiz=cos(loft), vert=sin(loft), AND loft itself costs extra power via loft_power_cost (a big lob 'spends' more of the kick's total power just lifting the ball). Higher loft -> higher arc but shorter horizontal distance.",

    ball_size: "Ball radius (rcssserver's ball_size, default 0.085). Used in the kickable-area formula (player_size+ball_size+kickable_margin) and purely visual sphere size - does not affect flight physics directly.",
    ball_decay: "Per-cycle horizontal (x,y) speed multiplier while the ball is ON THE GROUND (rcssserver's ball_decay, default 0.94). Lower = more friction/rolls to a stop faster. Does NOT affect vertical motion or airborne speed - see air_decay for that.",
    ball_rand: "Random noise magnitude added to a kick's direction/power (rcssserver's ball_rand). 0 = fully deterministic kicks (recommended while tuning formulas in this lab); >0 reintroduces the server's real kick randomness.",
    ball_speed_max: "Hard cap on horizontal (x,y) speed after a kick (rcssserver's ball_speed_max, default 3.0 units/cycle). Vertical (z) speed from loft is NOT clamped by this - only the horizontal component is.",
    ball_accel_max: "Hard cap on the horizontal (x,y) acceleration a single kick can apply (rcssserver's ball_accel_max, default 2.7). Prevents unrealistic instantaneous horizontal speed jumps; vertical (z) acceleration from loft is not clamped by this.",
    player_size: "Player's body radius (rcssserver's player_size, default 0.3). Used in the kickable-area circle test and the visual cylinder radius. Bigger player = can reach the ball from slightly farther away.",
    kick_power_rate: "Scale factor converting raw 'power' into eff_power (rcssserver's kick_power_rate, default 0.027). This is the single biggest lever on how much velocity a given power number actually produces - raise it for a much more powerful-feeling kick at the same power slider value.",
    kickable_margin: "Extra reach beyond player_size+ball_size within which the ball is still kickable (rcssserver's kickable_margin, default 0.7). Also appears in the eff_power formula: kicking a ball near the edge of this margin loses power vs. one right at your feet.",
    max_power: "Maximum power value NormalizeKickPower will allow (rcssserver's max_power, default 100). Raising it lets the power slider itself go higher, effectively raising the ceiling on eff_power.",
    gravity: "NEW parameter (not in rcssserver): per-cycle vertical speed lost each step (same unit scale as the kick's vz, NOT real-world 9.8 m/s^2 - see README). Lower = long floaty lob with more hang time; higher = snappier, lower arc that falls fast. Setting this too high (e.g. near 9.8) reproduces the 'ball barely leaves the ground' bug.",
    ball_bounce_restitution: "NEW parameter: fraction of vertical speed kept after each ground bounce (0 = dead stop on first touch, close to 1 = super bouncy). Applied every time the ball's z crosses back to 0 with |vz| above bounce_stop_speed. Default 0.5.",
    ball_bounce_friction: "NEW parameter: couples the bounce's vertical (normal) impulse to a one-time horizontal (x,y) speed LOSS at the instant of impact, approximating real Coulomb friction - inspired by how SimSpark/ODE resolve a bounce as one coupled normal+tangential impulse instead of two independent axes. maxLoss = ball_bounce_friction * (impact vz - post-bounce vz); the ball's horizontal speed is scaled down by at most that much (never reversed). 0 = old behavior (bounce never touches vx/vy, only ball_decay/air_decay slow it down over time); higher = a harder bounce bleeds off proportionally more horizontal speed on that single impact, matching the intuition that hitting the ground harder should cost you more total energy, not just vertical energy. Default 0.5.",
    loft_power_cost: "NEW parameter: fraction of eff_power 'spent' purely on lifting the ball, scaled by loft/90deg. At loft=90 with loft_power_cost=0.4, you only keep 60% of eff_power total. Raise it to make big lobs cost noticeably more power than grounders; set to 0 to make loft 'free' (same total power regardless of angle).",
    air_decay: "NEW parameter: per-cycle horizontal (x,y) speed multiplier while the ball is AIRBORNE (z>0), separate from ball_decay which only applies on the ground. Kept close to 1.0 (near-frictionless) by default since air resistance on a soccer ball is small - lower it to simulate more drag on a flying ball.",
    bounce_stop_speed: "NEW parameter: once a ground-touch's vertical speed magnitude drops below this threshold, the ball 'settles' (z locked to 0, vz set to 0) instead of bouncing again forever. Raise it to make the ball stop bouncing sooner/more abruptly.",
    roll_stop_speed: "NEW parameter: once a ball RESTING on the ground (already settled, vz=0) has its horizontal (x,y) speed decay below this threshold, it freezes completely (vx=vy=0) instead of creeping forever at a near-zero crawl. Separate from bounce_stop_speed, which only governs the vertical bounce->settle transition. Raise it to make rolling balls stop sooner/more abruptly; lower it to let them creep longer before fully stopping.",
    player_height: "MERGED parameter (previously two separate sliders, player_height + player_reach_height, that always shared the same default 2.0): visual height of the player cylinder (meters) AND the maximum ball z at which the ball is still considered kickable/headable (used in isBallKickable() alongside the normal 2D kickable-circle test). Lower it to simulate both 'a shorter player' and 'the ball flew over their head, they can't reach it' at once.",
    height_power_cost: "NEW parameter: fraction of eff_power lost as the ball's height approaches player_height (0 = ball on the ground costs nothing extra, 1 = a ball right at the reach-height cutoff loses ALL power). Mirrors the existing angle/distance power penalties - previously ball height had NO effect on kick power at all, only a binary reach cutoff. Set to 0 to make height free again (old behavior); raise it to make headers/volleys noticeably weaker than grounders.",
    dt: "Seconds represented by ONE simulation cycle (rcssserver's cycle = 0.1s = 100ms, matched here by default). Only affects real-time playback pacing (how fast Play advances cycles per wall-clock second) - it is NOT used inside the physics formulas themselves (pos/vel integration is purely per-cycle, matching rcssserver's own convention).",
    precise_bounce_timing: "Bounce-timing mode. ON (default): step() finds the exact fractional point within the cycle where z actually crosses 0 (linear interpolation), bounces the velocity there, then continues moving for the REMAINING fraction of the cycle with the reflected velocity - like mirroring the tail of the fall back upward instead of chopping it off. This is a continuous/analytical time-of-impact scheme, the same style rcssserver itself uses for its own ball-vs-goalpost collision (see compare.md). OFF (legacy/experimental): a cycle that would carry the ball below z=0 just clamps pos.z straight to 0 and bounces from there, discarding whatever fraction of that cycle's fall happened after the true ground-crossing instant - kept only as an A/B comparison toggle against the old default behavior. Turn this on/off and compare trajectories (especially at low gravity / large per-cycle falls) to see how much bounce placement shifts.",
  };

  // Defaults used by the per-variable AND "reset all" buttons. Kick command
  // sliders aren't part of DEFAULT_PARAMS (they're per-kick inputs, not physics
  // constants), so they get their own small defaults map; physics parameter
  // defaults come straight from window.DEFAULT_PARAMS (never mutated in place).
  const KICK_DEFAULTS = { power: 100, dir: 0, loft: 60 };
  const resettableInputs = []; // { input, defaultValue } - used by "Reset ALL parameters"

  function attachInfoButton(rowEl, key, defaultValue) {
    const label = rowEl.querySelector("label");
    const input = rowEl.querySelector("input[type=range]");
    if (!label || !input) return;

    // Group the value badge + "!"/"↺" buttons into one right-hand cluster so the
    // label stays a clean two-column layout (name on the left, controls on the
    // right) instead of flexbox spreading 3-4 loose items across the row.
    const valueSpan = label.querySelector("span");
    const rightGroup = document.createElement("span");
    rightGroup.className = "labelControls";
    if (valueSpan) rightGroup.appendChild(valueSpan); // moves it out of `label`, into rightGroup

    const btn = document.createElement("button");
    btn.className = "infoBtn";
    btn.type = "button";
    btn.textContent = "!";
    btn.title = "What does this do?";
    rightGroup.appendChild(btn);

    const resetBtn = document.createElement("button");
    resetBtn.className = "infoBtn resetBtn";
    resetBtn.type = "button";
    resetBtn.textContent = "↺";
    resetBtn.title = `Reset to default (${defaultValue})`;
    resetBtn.onclick = () => {
      input.value = defaultValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    rightGroup.appendChild(resetBtn);

    label.appendChild(rightGroup);

    const desc = document.createElement("div");
    desc.className = "paramDesc";
    desc.textContent = DESCRIPTIONS[key] || "No description available.";
    rowEl.appendChild(desc);

    btn.onclick = () => {
      const open = desc.classList.toggle("open");
      btn.classList.toggle("active", open);
    };

    resettableInputs.push({ input, defaultValue });
  }

  attachInfoButton(document.getElementById("row_power"), "power", KICK_DEFAULTS.power);
  attachInfoButton(document.getElementById("row_dir"), "dir", KICK_DEFAULTS.dir);
  attachInfoButton(document.getElementById("row_loft"), "loft", KICK_DEFAULTS.loft);

  // ---- dynamic parameter sliders (generated from DEFAULT_PARAMS ranges) ----
  const PARAM_RANGES = {
    ball_size:               [0.05, 0.2, 0.005],
    ball_decay:              [0.80, 0.99, 0.005],
    ball_rand:               [0.0, 0.3, 0.01],
    ball_speed_max:          [1.0, 8.0, 0.1],
    ball_accel_max:          [0.5, 6.0, 0.1],
    player_size:             [0.1, 0.6, 0.02],
    kick_power_rate:         [0.005, 0.08, 0.001],
    kickable_margin:         [0.1, 1.5, 0.05],
    max_power:               [50, 150, 1],
    gravity:                 [0.02, 2.0, 0.01],
    ball_bounce_restitution: [0.0, 0.95, 0.01],
    ball_bounce_friction:      [0.0, 1.0, 0.01],
    loft_power_cost:         [0.0, 0.9, 0.01],
    air_decay:               [0.90, 1.0, 0.001],
    bounce_stop_speed:       [0.0, 0.5, 0.01],
    roll_stop_speed:         [0.0, 0.5, 0.01],
    player_height:           [0.5, 2.5, 0.05],
    height_power_cost:       [0.0, 1.0, 0.01],
    dt:                      [0.02, 0.5, 0.01],
  };

  const sliderHost = $("paramSliders");

  // ---- boolean toggle parameters (checkbox, not a range slider) ----
  // Separate from PARAM_RANGES/the range-slider loop below since a checkbox
  // has no min/max/step and uses `.checked` instead of `.value`. Add new
  // boolean physics params to BOOL_PARAMS (plus a DEFAULT_PARAMS entry and a
  // DESCRIPTIONS entry above) rather than wiring one-off UI for each.
  const BOOL_PARAMS = ["precise_bounce_timing"];
  BOOL_PARAMS.forEach((key) => {
    const defaultValue = window.DEFAULT_PARAMS[key];
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = key;
    label.appendChild(nameSpan);

    const rightGroup = document.createElement("span");
    rightGroup.className = "labelControls";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!params[key];
    input.oninput = () => {
      params[key] = input.checked;
      sim.params[key] = input.checked;
    };
    rightGroup.appendChild(input);

    const btn = document.createElement("button");
    btn.className = "infoBtn";
    btn.type = "button";
    btn.textContent = "!";
    btn.title = "What does this do?";
    rightGroup.appendChild(btn);

    const resetBtn = document.createElement("button");
    resetBtn.className = "infoBtn resetBtn";
    resetBtn.type = "button";
    resetBtn.textContent = "↺";
    resetBtn.title = `Reset to default (${defaultValue})`;
    resetBtn.onclick = () => {
      input.checked = defaultValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    rightGroup.appendChild(resetBtn);

    label.appendChild(rightGroup);
    row.appendChild(label);

    const desc = document.createElement("div");
    desc.className = "paramDesc";
    desc.textContent = DESCRIPTIONS[key] || "No description available.";
    row.appendChild(desc);
    btn.onclick = () => {
      const open = desc.classList.toggle("open");
      btn.classList.toggle("active", open);
    };

    sliderHost.appendChild(row);
    resettableInputs.push({ input, defaultValue, isCheckbox: true });
  });

  Object.keys(PARAM_RANGES).forEach((key) => {
    const [min, max, step] = PARAM_RANGES[key];
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = key;
    const valSpan = document.createElement("span");
    valSpan.textContent = params[key];
    label.appendChild(nameSpan);
    label.appendChild(valSpan);
    const input = document.createElement("input");
    input.type = "range";
    input.min = min; input.max = max; input.step = step;
    input.value = params[key];
    input.oninput = () => {
      const v = parseFloat(input.value);
      valSpan.textContent = v;
      params[key] = v;
      sim.params[key] = v;
      // keep visuals in sync for size-affecting params
      if (key === "player_size" || key === "player_height") {
        player.geometry.dispose();
        player.geometry = new THREE.CylinderGeometry(params.player_size, params.player_size, params.player_height, 20);
        player.position.y = params.player_height / 2;
        sim.player.size = params.player_size;
        sim.player.height = params.player_height;
      }
      if (key === "ball_size") {
        ball.geometry.dispose();
        ball.geometry = new THREE.SphereGeometry(Math.max(params.ball_size, 0.08), 20, 20);
      }
    };
    row.appendChild(label);
    row.appendChild(input);
    sliderHost.appendChild(row);
    attachInfoButton(row, key, window.DEFAULT_PARAMS[key]);
  });

  // "Reset ALL parameters" — restores every kick/physics slider to its default
  // (does NOT touch ball position/velocity - that's the separate "Reset ⟲" button
  // in the Playback section, which resets the simulation state instead).
  $("btnResetAllParams").onclick = () => {
    resettableInputs.forEach(({ input, defaultValue, isCheckbox }) => {
      if (isCheckbox) input.checked = defaultValue; else input.value = defaultValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  // init number inputs — ball starts at x=0.3 (explicit default), just in front
  // of the player at the origin, rather than the computed kickable-edge distance.
  $("init_x").value = "0.3";
  $("init_y").value = 0;

  // ---------------- main loop ----------------
  function animate(nowMs) {
    requestAnimationFrame(animate);
    if (playing) {
      const speed = parseFloat(speedSlider.value);
      const dtWall = (nowMs - lastWall) / 1000;
      lastWall = nowMs;
      accum += dtWall * speed;
      const cycleDt = sim.params.dt; // dt is ONLY used to pace real-time playback (cycles per wall-second), not inside physics
      let guard = 0;
      while (accum >= cycleDt && guard < 50) {
        sim.step();
        accum -= cycleDt;
        guard++;
        // Auto-stop playback once the ball has fully settled (checked live
        // every step, so this works correctly even right after dragging the
        // Step scrubber bar to an earlier point and pressing Play again) —
        // otherwise Cycle/Time kept climbing forever with nothing left to show.
        if (sim.isAtRest()) { stopPlaying(); break; }
      }
      updateEventLog();
    }
    controls.update();
    renderFrame();
  }

  resize();
  doReset();
  requestAnimationFrame(animate);
})();
