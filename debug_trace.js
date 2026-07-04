/*
 * debug_trace.js — headless trace tool for the Kick Lab physics engine.
 *
 * Runs the EXACT same physics.js used in the browser (no duplication) under
 * Node, performs one kick, steps N cycles, and writes a full per-cycle log
 * to disk under ./logs/ — so bugs (weird bounces, ball not rising, etc.)
 * can be inspected/shared as a text file instead of only visually in the
 * browser.
 *
 * Usage:
 *   node debug_trace.js [power] [dir] [loft] [cycles] [paramOverridesJSON]
 *
 * Examples:
 *   node debug_trace.js                       # defaults: 100 0 80 60
 *   node debug_trace.js 100 0 80 60
 *   node debug_trace.js 100 0 80 60 "{\"gravity\":0.4}"
 */

const fs = require("fs");
const path = require("path");
const { KickLabPhysics, DEFAULT_PARAMS } = require("./physics.js");

const power = parseFloat(process.argv[2] ?? "100");
const dir = parseFloat(process.argv[3] ?? "0");
const loft = parseFloat(process.argv[4] ?? "80");
const cycles = parseInt(process.argv[5] ?? "60", 10);
const overrides = process.argv[6] ? JSON.parse(process.argv[6]) : {};

const params = { ...DEFAULT_PARAMS, ...overrides };
const sim = new KickLabPhysics(params);

const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = path.join(logsDir, `trace_${stamp}.log`);

const lines = [];
lines.push(`# Kick Lab debug trace`);
lines.push(`# params: ${JSON.stringify(params)}`);
lines.push(`# kick(power=${power}, dir=${dir}, loft=${loft}), cycles=${cycles}`);
lines.push(`# ball starts at pos=(${sim.ball.pos.x.toFixed(3)},${sim.ball.pos.y.toFixed(3)},${sim.ball.pos.z.toFixed(3)})`);

const kickInfo = sim.kick(power, dir, loft);
lines.push(`# kickInfo: ${JSON.stringify(kickInfo)}`);
lines.push("");
lines.push("cycle,x,y,z,vx,vy,vz,speed");
lines.push(`${sim.cycle},${sim.ball.pos.x.toFixed(4)},${sim.ball.pos.y.toFixed(4)},${sim.ball.pos.z.toFixed(4)},${sim.ball.vel.x.toFixed(4)},${sim.ball.vel.y.toFixed(4)},${sim.ball.vel.z.toFixed(4)},${sim.speed().toFixed(4)}`);

let peakZ = sim.ball.pos.z;
let peakCycle = 0;
for (let i = 0; i < cycles; i++) {
  sim.step();
  const b = sim.ball;
  lines.push(`${sim.cycle},${b.pos.x.toFixed(4)},${b.pos.y.toFixed(4)},${b.pos.z.toFixed(4)},${b.vel.x.toFixed(4)},${b.vel.y.toFixed(4)},${b.vel.z.toFixed(4)},${sim.speed().toFixed(4)}`);
  if (b.pos.z > peakZ) { peakZ = b.pos.z; peakCycle = sim.cycle; }
}

lines.push("");
lines.push(`# events:`);
sim.events.forEach((e) => lines.push(`# [${e.cycle}] ${e.text}`));
lines.push("");
lines.push(`# SUMMARY: peak height z=${peakZ.toFixed(4)} at cycle ${peakCycle}; final pos=(${sim.ball.pos.x.toFixed(3)},${sim.ball.pos.y.toFixed(3)},${sim.ball.pos.z.toFixed(3)})`);

fs.writeFileSync(logPath, lines.join("\n"), "utf8");
console.log(`Wrote ${lines.length} lines to ${logPath}`);
console.log(`Peak height: ${peakZ.toFixed(4)} at cycle ${peakCycle}`);
