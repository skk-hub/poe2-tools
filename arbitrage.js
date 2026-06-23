window.__viewInit=window.__viewInit||{};
window.__viewInit["arbitrage"]=function(){
const els = {
  status: document.getElementById("abStatus"),
  scanBtn: document.getElementById("scanBtn"),
  results: document.getElementById("abResults"),
  summary: document.getElementById("abSummary"),
  budgetEx: document.getElementById("budgetEx"),
  minProfitEx: document.getElementById("minProfitEx"),
  minProfitPct: document.getElementById("minProfitPct"),
  minStock: document.getElementById("minStock"),
  slippagePct: document.getElementById("slippagePct"),
  catCurrency: document.getElementById("catCurrency"),
  catFragments: document.getElementById("catFragments"),
  forceRefresh: document.getElementById("forceRefresh"),
};
function esc(s){return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
function num(id){return Number(els[id].value) || 0;}
function fmt(n, d=2){return Number(n || 0).toLocaleString(undefined, {maximumFractionDigits:d});}
function setStatus(text, cls=""){els.status.textContent = text; els.status.className = "statusline " + cls;}
function limitUntil(data){ return data?.tradeStatus?.tradeLimitedUntil || data?.tradeLimitedUntil || ""; }
function fmtLimitUntil(data){ const raw = limitUntil(data); if (!raw) return ""; const d = new Date(raw); return Number.isNaN(d.getTime()) ? raw : d.toLocaleString(); }
function payload(){
  return {
    budgetEx: num("budgetEx"), minProfitEx: num("minProfitEx"), minProfitPct: num("minProfitPct"),
    minStock: num("minStock"), slippagePct: num("slippagePct"),
    categories: { currency: els.catCurrency.checked, fragments: els.catFragments.checked },
    force: els.forceRefresh.checked,
  };
}
function renderSummary(data){
  const rows = data.opportunities || [];
  const best = rows[0];
  els.summary.style.display = "grid";
  els.summary.innerHTML = `
    <div class="metric"><b>${rows.length}</b><span>shown flips</span></div>
    <div class="metric"><b>${best ? fmt(best.netProfitEx) : "0"} ex</b><span>best net profit</span></div>
    <div class="metric"><b>${best ? fmt(best.roiPct) : "0"}%</b><span>best ROI</span></div>
    <div class="metric"><b>${data.cached ? "Cache" : data.stale ? "Stale" : "Live"}</b><span>${esc(data.updated || data.cachedAt || "")}</span></div>`;
}
function nearMissBlock(data){
  const rows = data.nearMiss || [];
  if (!rows.length) return "";
  return `<div class="nearmiss"><div class="nearmiss-head">Closest spreads found (below your filters)</div>
    <div class="tablewrap"><table>
      <thead><tr><th>Item</th><th>Buy</th><th>Sell</th><th>Net</th><th>ROI</th></tr></thead>
      <tbody>${rows.map(row => `
        <tr>
          <td><div class="name">${esc(row.name)}</div></td>
          <td class="num">${fmt(row.askExPerItem,4)} ex</td>
          <td class="num">${fmt(row.bidExPerItem,4)} ex</td>
          <td class="num ${row.netProfitEx < 0 ? "warn" : "profit"}">${fmt(row.netProfitEx)} ex</td>
          <td class="num ${row.roiPct < 0 ? "warn" : ""}">${fmt(row.roiPct)}%</td>
        </tr>`).join("")}</tbody>
    </table></div></div>`;
}
function render(data){
  renderSummary(data);
  const rows = data.opportunities || [];
  if (!rows.length) {
    const until = fmtLimitUntil(data);
    const scanned = (data.universe || []).length;
    const skipped = (data.errors || []).length;
    els.results.className = "empty";
    els.results.innerHTML = data.limited
      ? "Trade2 is currently rate-limited" + (until ? " until " + esc(until) : "") + " and no matching cached opportunities are available."
      : `Scanned ${scanned} pair${scanned === 1 ? "" : "s"} — none cleared your net-profit / ROI / stock filters. The Currency Exchange spread is usually negative for an instant round-trip, so profitable flips are brief mispricings; lower the thresholds or re-scan later.`
        + (skipped ? ` (${skipped} had no offer on one side.)` : "")
        + nearMissBlock(data);
    return;
  }
  els.results.className = "";
  els.results.innerHTML = `
    <div class="tablewrap"><table>
      <thead><tr><th>Item</th><th>Buy</th><th>Sell</th><th>Size</th><th>Spend</th><th>Net</th><th>ROI</th><th>Stock</th><th>Flags</th></tr></thead>
      <tbody>${rows.map(row => `
        <tr>
          <td><div class="name">${esc(row.name)}</div><div class="cat">${esc(row.category)}</div></td>
          <td class="num">${fmt(row.askExPerItem,4)} ex/item</td>
          <td class="num">${fmt(row.bidExPerItem,4)} ex/item<br><span class="cat">net ${fmt(row.netBidExPerItem,4)}</span></td>
          <td class="num">${fmt(row.executableItems,0)}</td>
          <td class="num">${fmt(row.spendEx)} ex</td>
          <td class="num profit">${fmt(row.netProfitEx)} ex</td>
          <td class="num ${row.roiPct < 5 ? "warn" : ""}">${fmt(row.roiPct)}%</td>
          <td class="num">${fmt(row.buyStock,0)} buy<br>${fmt(row.sellStock,0)} sell</td>
          <td>${(row.flags || []).length ? row.flags.map(f => `<span class="flag">${esc(f)}</span>`).join("") : `<span class="flag">ok</span>`}</td>
        </tr>`).join("")}</tbody>
    </table></div>
    ${data.errors && data.errors.length ? `<div class="errors"><b>Skipped:</b> ${esc(data.errors.slice(0,6).map(e => e.item + " (" + e.reason + ")").join(", "))}${data.errors.length > 6 ? " …" : ""}</div>` : ""}`;
}
async function scan(){
  els.scanBtn.disabled = true;
  setStatus("Scanning Currency Exchange through shared Trade2 queue…", "warn");
  try {
    const res = await fetch("/api/arbitrage/scan", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload()) });
    const data = await res.json();
    render(data);
    if (data.limited) { const until = fmtLimitUntil(data); setStatus("Trade2 is rate-limited" + (until ? " until " + until : "") + " — showing cached data when available.", "err"); }
    else if (data.cached) setStatus("Loaded cached scan from " + (data.updated || "recently") + ".", "ok");
    else setStatus("Scan complete: " + (data.opportunities || []).length + " opportunities.", "ok");
  } catch (err) {
    els.results.className = "empty"; els.results.textContent = "Scan failed: " + err.message; setStatus("Scan failed.", "err");
  } finally { els.scanBtn.disabled = false; }
}
els.scanBtn.addEventListener("click", scan);
};
