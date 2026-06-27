// Offline self-check for the EE2 proxy parser (poe.ninja overviewData.json). No
// network — feeds a synthetic blob shaped like the real one. Run: node ee2-proxy-test.js
const assert = require("assert");
const { parseProxyOverview, getProxyData, proxyPrice, __setProxyFetchImpl } = require("./server.js");

// Real shape: core.rates are per-divine (exalted=ex-per-div, chaos=chaos-per-div);
// each line's primaryValue is in divine.
const blob = {
  core: { rates: { exalted: 383, chaos: 9.91 }, primary: "div" },
  itemOverviews: [
    { type: "Currency", lines: [{ name: "Chaos Orb", primaryValue: 0.1009, volumePrimaryValue: 200000 }] },
    { type: "Runes", lines: [{ name: "Masterwork Rune", primaryValue: 0.254, volumePrimaryValue: 513 }] },
    { type: "Verisium", lines: [{ name: "Celestial Alloy", primaryValue: 0.6675, volumePrimaryValue: 161 }] },
  ],
};

const p = parseProxyOverview(blob);
assert.strictEqual(p.divineEx, 383, "divineEx = rates.exalted");
assert.ok(Math.abs(p.chaosEx - 38.6) < 0.5, "chaosEx = divineEx / rates.chaos (~38.6)");
assert.strictEqual(proxyPrice(p, "Masterwork Rune").ex, Math.round(0.254 * 383 * 10000) / 10000, "Masterwork value = primaryValue × divineEx");
assert.ok(Math.abs(proxyPrice(p, "Masterwork Rune").ex - 97.3) < 1, "Masterwork ≈ 97 ex");
assert.strictEqual(proxyPrice(p, "Exalted Orb").ex, 1, "Exalted is the 1 ex base unit");
assert.strictEqual(proxyPrice(p, "Divine Orb").ex, 383, "Divine = divineEx");
assert.strictEqual(proxyPrice(p, "Celestial Alloy").volume, 161, "volume carried through");
assert.strictEqual(proxyPrice(p, "Nonexistent Thing"), null, "unknown item → null (caller falls back to bulk)");

// getProxyData with a stubbed fetch (no network), confirms SWR returns the parsed data.
__setProxyFetchImpl(async () => p);
(async () => {
  const d = await getProxyData("Runes of Aldur", true);
  assert.ok(d && d.divineEx === 383, "getProxyData returns parsed data via stubbed fetch");
  console.log("ee2-proxy-test: all assertions passed");
})();
