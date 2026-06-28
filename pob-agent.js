// pob-agent.js — run this on the Main PC (where Path of Building + LuaJIT live).
// It exposes the headless PoB bridge over HTTP so the VM-hosted app can use it:
// set POB_BRIDGE_URL=http://<this-pc-lan-or-tailscale-ip>:17778 on the VM.
//
//   node pob-agent.js          # leave it running while you use the Gear Finder
//
// LAN/Tailscale only — do NOT expose to the public internet (it runs PoB on the
// build XML you send it). Do NOT set POB_BRIDGE_URL in THIS process's env (that
// would make pob.js try to proxy to itself).
const http = require("http");
const pob = require("./pob.js");

const PORT = Number(process.env.POB_AGENT_PORT) || 17778;
const HOST = process.env.POB_AGENT_HOST || "0.0.0.0";

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b), "Access-Control-Allow-Origin": "*" });
  res.end(b);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 16 * 1024 * 1024) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

if (pob.REMOTE) { console.error("[pob-agent] REFUSING: POB_BRIDGE_URL is set in this process — unset it (the agent must run pob.js in LOCAL mode)."); process.exit(1); }
if (!pob.localAvailable()) console.warn("[pob-agent] WARNING: PoB/LuaJIT not found locally — health will report available:false. Check the install paths / POB_DIR / POB_LUAJIT.");

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/pob/health") { send(res, 200, { ok: true, available: pob.available() }); return; }
    if (u.pathname === "/pob/load" && req.method === "POST") { const { xml } = await readJson(req); send(res, 200, await pob.load(String(xml || ""))); return; }
    if (u.pathname === "/pob/calc" && req.method === "POST") { const { slot, itemText } = await readJson(req); send(res, 200, await pob.calc(String(slot || ""), String(itemText || ""))); return; }
    if (u.pathname === "/pob/calcmulti" && req.method === "POST") { const { pairs } = await readJson(req); send(res, 200, await pob.calcMulti(Array.isArray(pairs) ? pairs : [])); return; }
    if (u.pathname === "/pob/tree" && req.method === "POST") { const { maxDepth } = await readJson(req); send(res, 200, await pob.tree(Number(maxDepth) || 5)); return; }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 200, { error: String(e && e.message) }); }
});
server.listen(PORT, HOST, () => console.log(`[pob-agent] headless PoB bridge on http://${HOST}:${PORT}  (available=${pob.available()})  — set POB_BRIDGE_URL to this on the VM`));
