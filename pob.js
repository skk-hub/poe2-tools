// pob.js — drive the headless Path of Building bridge (pob-bridge.lua) to compute
// build stats and candidate-item DPS/EHP deltas for the Gear Upgrade Finder.
//
// Spawns ONE persistent luajit subprocess (PoB loads its data once, ~3-5s) and
// talks to it over a length-framed stdio protocol. Zero deps (child_process/fs/
// path). Graceful: available() is false (no spawn) when luajit / the PoB install /
// the bridge are missing, so the tool falls back to stat-only ranking.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

const BRIDGE = path.join(__dirname, "pob-bridge.lua");
// Configurable; defaults match a standard PoB-PoE2 + winget LuaJIT install.
const POB_DIR = process.env.POB_DIR || path.join(APPDATA, "Path of Building Community (PoE2)");
const LUAJIT_CANDIDATES = [
  process.env.POB_LUAJIT,
  path.join(LOCALAPPDATA, "Programs", "LuaJIT", "bin", "luajit.exe"),
  "luajit", // on PATH
].filter(Boolean);

function firstExisting(paths) {
  for (const p of paths) { try { if (p === "luajit" || fs.existsSync(p)) return p; } catch {} }
  return null;
}
function luajitPath() { return firstExisting(LUAJIT_CANDIDATES); }

function localAvailable() {
  try {
    return !!luajitPath() && fs.existsSync(BRIDGE) && fs.existsSync(path.join(POB_DIR, "Launch.lua"));
  } catch { return false; }
}

let proc = null, procReady = false, queue = [], cur = null;
let buf = Buffer.alloc(0), stderrTail = "";

function kill() {
  if (proc) { try { proc.kill(); } catch {} }
  proc = null; procReady = false; cur = null; queue = []; buf = Buffer.alloc(0);
}

function spawnProc() {
  const lj = luajitPath();
  proc = spawn(lj, [BRIDGE, "--rpc"], { cwd: POB_DIR, windowsHide: true });
  proc.stdout.on("data", onData);
  proc.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  proc.on("exit", () => { const e = new Error("pob bridge exited: " + stderrTail.slice(-300)); fail(e); kill(); });
  proc.on("error", (e) => { fail(e); kill(); });
}

function fail(err) {
  if (cur) { cur.reject(err); cur = null; }
  while (queue.length) queue.shift().reject(err);
}

// Frame parser: "<TAG> <N>\r?\n" + N payload bytes.
function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return;
    const header = buf.slice(0, nl).toString("latin1").replace(/\r$/, "");
    const m = header.match(/^([A-Z]+)\s+(\d+)$/);
    if (!m) { buf = buf.slice(nl + 1); continue; } // skip stray boot line
    const n = Number(m[2]);
    if (buf.length < nl + 1 + n) return; // wait for full payload
    const payload = buf.slice(nl + 1, nl + 1 + n).toString("utf8");
    buf = buf.slice(nl + 1 + n);
    handleFrame(m[1], payload);
  }
}

function handleFrame(tag, payload) {
  if (tag === "READY") { procReady = true; pump(); return; }
  if (!cur) return;
  const c = cur; cur = null;
  if (tag === "OK") { try { c.resolve(payload ? JSON.parse(payload) : {}); } catch { c.resolve({}); } }
  else c.reject(new Error("pob: " + payload));
  pump();
}

function pump() {
  if (!procReady || cur || !queue.length) return;
  cur = queue.shift();
  const head = Buffer.from(cur.cmd + " " + Buffer.byteLength(cur.payload) + "\n", "utf8");
  proc.stdin.write(Buffer.concat([head, Buffer.from(cur.payload, "utf8")]));
}

function send(cmd, payload = "", timeoutMs = 20000) {
  if (!available()) return Promise.reject(new Error("pob unavailable"));
  if (!proc) spawnProc();
  // Normalize to LF: the bridge reads stdin in Windows text mode, which collapses
  // CRLF→LF on read, so a CRLF payload would under-fill the byte count and hang.
  payload = String(payload).replace(/\r\n?/g, "\n");
  return new Promise((resolve, reject) => {
    const job = { cmd, payload, resolve, reject };
    const timer = setTimeout(() => reject(new Error("pob timeout")), timeoutMs);
    const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
    job.resolve = wrap(resolve); job.reject = wrap(reject);
    queue.push(job); pump();
  });
}

// Local (spawn) public API
async function localLoad(buildXml) { return send("LOAD", buildXml, 30000); }      // -> base stats
async function localCalc(slot, itemText) { return send("CALC", String(slot) + "\n" + String(itemText)); } // -> swapped stats
// Equip several items at once (one per slot) and recompute → combined stats. pairs:
// [{slot, itemText}]. Each block is length-framed so item text newlines are safe.
async function localCalcMulti(pairs) {
  const parts = (Array.isArray(pairs) ? pairs : []).map((p) => {
    const item = String(p.itemText || "").replace(/\r\n?/g, "\n");
    return String(p.slot || "") + "\n" + Buffer.byteLength(item, "utf8") + "\n" + item;
  });
  return send("CALCM", parts.join("\n"), 30000);
}
// Passive-tree move values for the loaded build (call after load). maxDepth = how many
// points away to scan unallocated notables. Slow (one PoB calc per candidate) → long timeout.
async function localTree(maxDepth) { return send("TREE", String(maxDepth || 5), 180000); }
function shutdown() { if (proc) { try { send("QUIT").catch(() => {}); } catch {} setTimeout(kill, 500); } }

// ── Remote mode ────────────────────────────────────────────────────────────
// When POB_BRIDGE_URL is set (e.g. the VM pointing at a pob-agent.js on the Main
// PC where PoB+LuaJIT live), proxy load/calc to that agent over HTTP instead of
// spawning luajit locally. Lets the VM-hosted app use the PC's Path of Building.
const REMOTE = (process.env.POB_BRIDGE_URL || "").trim().replace(/\/+$/, "") || null;

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function remoteCall(pathSeg, body, timeoutMs) {
  const r = await fetchWithTimeout(REMOTE + pathSeg, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
  if (!r.ok) throw new Error("pob agent HTTP " + r.status);
  const j = await r.json();
  if (j && j.error) throw new Error("pob agent: " + j.error);
  return j;
}

// available() is sync (called in many spots) → optimistic when remote (a failed
// call degrades gracefully); ready() is the async, accurate health check.
function available() { return REMOTE ? true : localAvailable(); }
async function ready() {
  if (!REMOTE) return localAvailable();
  try { const r = await fetchWithTimeout(REMOTE + "/pob/health", {}, 4000); const j = await r.json(); return !!(j && j.available); }
  catch { return false; }
}
async function load(buildXml) { return REMOTE ? remoteCall("/pob/load", { xml: buildXml }, 30000) : localLoad(buildXml); }
async function calc(slot, itemText) { return REMOTE ? remoteCall("/pob/calc", { slot, itemText }) : localCalc(slot, itemText); }
async function calcMulti(pairs) { return REMOTE ? remoteCall("/pob/calcmulti", { pairs }, 30000) : localCalcMulti(pairs); }
async function tree(maxDepth) { return REMOTE ? remoteCall("/pob/tree", { maxDepth }, 180000) : localTree(maxDepth); }

module.exports = { available, ready, load, calc, calcMulti, tree, shutdown, localAvailable, luajitPath, POB_DIR, BRIDGE, REMOTE };
