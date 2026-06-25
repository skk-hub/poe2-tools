// Offline check for the trade-queue record/replay layer. Proves REPLAY serves
// fixtures with zero network + zero rate-limit budget, and a miss throws (never a
// silent live call). No network is touched. Run: node trade-queue-test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createTradeQueue } = require("./trade-queue.js");

// Mirror the queue's own key so we can seed a fixture deterministically.
function key(method, url, body) {
  const pathQ = url.replace(/^https?:\/\/[^/]+/i, "");
  return crypto.createHash("sha1").update(method.toUpperCase() + " " + pathQ + " " + (body || "")).digest("hex").slice(0, 16);
}

const fixtureFile = path.join(os.tmpdir(), "tq-fixtures-" + Date.now() + ".json");
const statusFile = path.join(os.tmpdir(), "tq-status-" + Date.now() + ".json");
const url = "https://www.pathofexile.com/api/trade2/search/poe2/Test";
const body = JSON.stringify({ query: { type: "x" } });

// Seed one search fixture and mark the status file as HARD rate-limited — replay
// must ignore that and still serve the fixture.
fs.writeFileSync(fixtureFile, JSON.stringify({
  [key("POST", url, body)]: { method: "POST", path: "/api/trade2/search/poe2/Test", response: { id: "abc", result: ["r1", "r2"], total: 2 } },
}));
fs.writeFileSync(statusFile, JSON.stringify({ tradeBlockedUntil: Date.now() + 9e6 }));

let n = 0;
const t = (name, fn) => fn().then(() => { n++; console.log("  ok -", name); });

(async () => {
  const q = createTradeQueue({ statusFile, replay: true, fixtureFile });

  await t("replay status reports not-limited despite a blocked status file", async () => {
    assert.strictEqual(q.status().limited, false);
    assert.strictEqual(q.status().replay, true);
  });

  await t("replay returns the recorded response (no network)", async () => {
    const r = await q.request(url, { method: "POST", body });
    assert.deepStrictEqual(r.result, ["r1", "r2"]);
    assert.strictEqual(r.id, "abc");
  });

  await t("replay returns a deep copy (mutation can't poison the cache)", async () => {
    const a = await q.request(url, { method: "POST", body });
    a.result.push("mutated");
    const b = await q.request(url, { method: "POST", body });
    assert.strictEqual(b.result.length, 2);
  });

  await t("a fixture MISS throws — never a silent live call", async () => {
    let threw = false;
    try { await q.request("https://www.pathofexile.com/api/trade2/search/poe2/Missing", { method: "POST", body }); }
    catch (e) { threw = /no fixture/.test(e.message); }
    assert.ok(threw, "expected a no-fixture throw");
  });

  fs.unlinkSync(fixtureFile); fs.unlinkSync(statusFile);
  console.log(`\ntrade-queue-test: ${n} checks passed (offline replay, zero network)`);
})().catch((e) => { console.error(e); process.exit(1); });
