window.__viewInit=window.__viewInit||{};
window.__viewInit["gear-search"]=function(){

    const state = {
      analysis: null,
      selectedSlot: "bow",
      selectedItem: null,
      slots: {},
      result: null,
      importOpen: true,
      lockedItems: {},
      slotImports: {},
    };

    const IMPORT_SLOTS = [
      { id: "bow", label: "Bow", match: /Item Class:\s*Bows/i },
      { id: "quiver", label: "Quiver", match: /Item Class:\s*Quivers/i },
      { id: "amulet", label: "Amulet", match: /Item Class:\s*Amulets/i },
      { id: "helmet", label: "Helmet", match: /Item Class:\s*Helmets/i },
      { id: "chest", label: "Body Armour", match: /Item Class:\s*Body Armours/i },
      { id: "boots", label: "Boots", match: /Item Class:\s*Boots/i },
      { id: "gloves", label: "Gloves", match: /Item Class:\s*Gloves/i },
      { id: "ring1", label: "Ring 1", match: /Item Class:\s*Rings/i },
      { id: "ring2", label: "Ring 2", match: /Item Class:\s*Rings/i },
      { id: "belt", label: "Belt", match: /Item Class:\s*Belts/i },
    ];

    const CONSOLE_EXPORT_SNIPPET = `(() => {
  const seen = new WeakSet();
  const items = [];
  const itemKey = (item) => [item.inventoryId, item.name, item.typeLine, JSON.stringify(item.explicitMods || [])].join("|");
  const addItem = (value) => {
    if (!value || typeof value !== "object") return;
    const hasName = value.name || value.typeLine;
    const hasMods = Array.isArray(value.explicitMods) || Array.isArray(value.implicitMods) || Array.isArray(value.craftedMods);
    if (hasName && (hasMods || value.inventoryId)) {
      const key = itemKey(value);
      if (!items.some((item) => itemKey(item) === key)) items.push(value);
    }
  };
  const walk = (value, depth = 0) => {
    if (!value || depth > 8) return;
    if (typeof value === "string") {
      if (/inventoryId|explicitMods|typeLine/.test(value)) {
        try { walk(JSON.parse(value), depth + 1); } catch {}
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    addItem(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry, depth + 1));
      return;
    }
    Object.keys(value).slice(0, 250).forEach((key) => walk(value[key], depth + 1));
  };

  document.querySelectorAll("script").forEach((script) => {
    const text = script.textContent || "";
    if (!/inventoryId|explicitMods|typeLine|__NUXT__|__NEXT_DATA__/.test(text)) return;
    if (script.type === "application/json" || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try { walk(JSON.parse(text)); } catch {}
    }
    for (const match of text.matchAll(/\\{[^{}]*(?:"typeLine"|"explicitMods"|"inventoryId")[\\s\\S]{0,5000}?\\}/g)) {
      try { walk(JSON.parse(match[0])); } catch {}
    }
  });
  ["__NUXT__", "__NEXT_DATA__", "__INITIAL_STATE__", "__APOLLO_STATE__"].forEach((key) => {
    try { walk(window[key]); } catch {}
  });
  ["localStorage", "sessionStorage"].forEach((storeName) => {
    const store = window[storeName];
    if (!store) return;
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      const value = store.getItem(key);
      if (/inventoryId|explicitMods|typeLine/.test(value || "")) walk(value);
    }
  });

  const exportText = JSON.stringify({
    source: "poe2-console-export",
    url: location.href,
    exportedAt: new Date().toISOString(),
    itemCount: items.length,
    items
  }, null, 2);
  const done = () => console.log("PoE Tools export copied:", items.length, "items. Paste it into Advanced raw import.");
  const fail = () => {
    console.log("Clipboard blocked. Copy the export JSON below and paste it into Advanced raw import.");
    console.log(exportText);
  };
  if (!items.length) console.warn("No item data found on this page. Open the character/equipment page first, then run this again.");
  if (typeof copy === "function") {
    copy(exportText);
    done();
  } else {
    navigator.clipboard.writeText(exportText).then(done).catch(fail);
  }
})();`;

    const IMPORT_PROFILES_KEY = "poe2.gearSearch.importProfiles";
    const IMPORT_TEXT_KEY = "poe2.gearSearch.text";

    const els = {
      importShell: document.getElementById("importShell"),
      importBody: document.getElementById("importBody"),
      importToggle: document.getElementById("importToggle"),
      slotImportGrid: document.getElementById("slotImportGrid"),
      importProgressFill: document.getElementById("importProgressFill"),
      importProgressText: document.getElementById("importProgressText"),
      importSaveName: document.getElementById("importSaveName"),
      importProfileSelect: document.getElementById("importProfileSelect"),
      consoleSnippet: document.getElementById("consoleSnippet"),
      gearText: document.getElementById("gearText"),
      status: document.getElementById("status"),
      slotSelect: document.getElementById("slotSelect"),
      budget: document.getElementById("budget"),
      matchMode: document.getElementById("matchMode"),
      minMatches: document.getElementById("minMatches"),
      filters: document.getElementById("filters"),
      queryPreview: document.getElementById("queryPreview"),
      summary: document.getElementById("summary"),
      lockedPanel: document.getElementById("lockedPanel"),
      results: document.getElementById("results"),
    };

    async function api(path, body) {
      const options = body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
      const res = await fetch(path, options);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "HTTP " + res.status);
      return data;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
    }

    function fmt(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "0";
      return Math.round(number * 100) / 100;
    }

    function currentItem() {
      if (!state.analysis) return null;
      return state.analysis.equipped[state.selectedSlot] || null;
    }

    function slotLabel(slotId) {
      return state.slots[slotId] ? state.slots[slotId].label : slotId;
    }

    function importSlotLabel(slotId) {
      const slot = IMPORT_SLOTS.find((item) => item.id === slotId);
      return slot ? slot.label : slotLabel(slotId);
    }

    function copiedItemParts(text) {
      return String(text || "")
        .split(/\r?\n(?=Item Class:)/g)
        .map((part) => part.trim())
        .filter((part) => /^Item Class:/i.test(part));
    }

    function detectImportSlot(text) {
      const source = String(text || "");
      const slotMatch = source.match(/^Slot:\s*(.+)$/im);
      if (slotMatch) {
        const value = slotMatch[1].trim().toLowerCase().replace(/\s+/g, " ");
        if (value === "ring 1" || value === "ring1") return "ring1";
        if (value === "ring 2" || value === "ring2") return "ring2";
      }
      const slot = IMPORT_SLOTS.find((item) => item.id !== "ring2" && item.match.test(source));
      return slot ? slot.id : "";
    }

    function slotBase(slotId) {
      return slotId === "ring1" || slotId === "ring2" ? "ring" : slotId;
    }

    function slotLooksCompatible(text, slotId) {
      if (!String(text || "").trim()) return { ok: false, message: "Empty" };
      const detected = detectImportSlot(text);
      if (!detected) return { ok: false, message: "Unknown" };
      if (slotBase(detected) === slotBase(slotId)) return { ok: true, message: "Ready" };
      return { ok: false, message: importSlotLabel(detected) };
    }

    function ensureSlotLine(text, slotId) {
      const clean = String(text || "").trim().replace(/^Slot:\s*.+$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!clean) return "";
      const slotLine = "Slot: " + importSlotLabel(slotId);
      if (/^Rarity:/im.test(clean)) return clean.replace(/^(Rarity:\s*.+)$/im, "$1\n" + slotLine);
      const lines = clean.split(/\r?\n/);
      lines.splice(1, 0, slotLine);
      return lines.join("\n");
    }

    function compiledImportText() {
      const parts = IMPORT_SLOTS
        .map((slot) => ensureSlotLine(state.slotImports[slot.id] || "", slot.id))
        .filter(Boolean);
      return parts.length ? parts.join("\n") : els.gearText.value;
    }

    function syncRawFromSlots() {
      const text = compiledImportText();
      els.gearText.value = text || "";
      return els.gearText.value;
    }

    function loadImportProfiles() {
      try {
        const value = JSON.parse(localStorage.getItem(IMPORT_PROFILES_KEY) || "{}");
        return value && typeof value === "object" ? value : {};
      } catch {
        return {};
      }
    }

    function saveImportProfiles(profiles) {
      localStorage.setItem(IMPORT_PROFILES_KEY, JSON.stringify(profiles || {}));
    }

    function renderImportProfiles(selectedName = "") {
      const profiles = loadImportProfiles();
      const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
      els.importProfileSelect.innerHTML = names.length
        ? names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
        : `<option value="">No saved imports</option>`;
      els.importProfileSelect.disabled = !names.length;
      if (selectedName && profiles[selectedName]) els.importProfileSelect.value = selectedName;
    }

    function selectedImportProfileName() {
      return els.importProfileSelect.value || "";
    }

    function saveCurrentImportProfile() {
      const name = (els.importSaveName.value || selectedImportProfileName()).trim();
      if (!name) {
        els.importSaveName.placeholder = "Type a save name first";
        els.importSaveName.focus();
        return;
      }
      const text = syncRawFromSlots();
      const profiles = loadImportProfiles();
      profiles[name] = { name, text, savedAt: new Date().toISOString() };
      saveImportProfiles(profiles);
      localStorage.setItem(IMPORT_TEXT_KEY, text || "");
      renderImportProfiles(name);
      els.importSaveName.value = name;
      setImportOpen(false);
    }

    async function loadSelectedImportProfile() {
      const name = selectedImportProfileName();
      const profiles = loadImportProfiles();
      const entry = name ? profiles[name] : null;
      els.gearText.value = entry ? (entry.text || "") : (localStorage.getItem(IMPORT_TEXT_KEY) || "");
      if (entry) els.importSaveName.value = name;
      hydrateSlotImports(els.gearText.value);
      if (els.gearText.value.trim()) await analyze();
    }

    function deleteSelectedImportProfile() {
      const name = selectedImportProfileName();
      if (!name) return;
      const profiles = loadImportProfiles();
      delete profiles[name];
      saveImportProfiles(profiles);
      if (els.importSaveName.value.trim() === name) els.importSaveName.value = "";
      renderImportProfiles();
    }

    function hydrateSlotImports(text) {
      state.slotImports = {};
      const ringSlots = ["ring1", "ring2"];
      let nextRing = 0;
      for (const part of copiedItemParts(text)) {
        let slotId = detectImportSlot(part);
        if (slotId === "ring1" && state.slotImports.ring1 && !state.slotImports.ring2) slotId = "ring2";
        if (slotId === "ring1" && !/^Slot:\s*Ring\s*1/im.test(part) && !/^Slot:\s*Ring\s*2/im.test(part)) {
          slotId = ringSlots[nextRing] || "ring2";
          nextRing += 1;
        }
        if (slotId && !state.slotImports[slotId]) state.slotImports[slotId] = part;
      }
      renderSlotImportGrid();
    }

    function updateImportProgress() {
      const filled = IMPORT_SLOTS.filter((slot) => String(state.slotImports[slot.id] || "").trim()).length;
      const percent = Math.round((filled / IMPORT_SLOTS.length) * 100);
      els.importProgressFill.style.width = percent + "%";
      els.importProgressText.textContent = filled + " / " + IMPORT_SLOTS.length + " slots";
    }

    function updateSlotCardStatus(textarea) {
      const card = textarea.closest(".slot-card");
      const status = slotLooksCompatible(textarea.value, textarea.getAttribute("data-slot-text"));
      if (!card) return;
      card.classList.toggle("filled", !!textarea.value.trim() && status.ok);
      card.classList.toggle("warn", !!textarea.value.trim() && !status.ok);
      const stateEl = card.querySelector(".slot-state");
      if (stateEl) stateEl.textContent = textarea.value.trim() ? (status.ok ? "Ready" : "Check: " + status.message) : "Missing";
    }

    function renderSlotImportGrid() {
      updateImportProgress();
      els.slotImportGrid.innerHTML = IMPORT_SLOTS.map((slot) => {
        const value = state.slotImports[slot.id] || "";
        const status = slotLooksCompatible(value, slot.id);
        const filledClass = value.trim() ? (status.ok ? "filled" : "warn") : "";
        const stateText = value.trim() ? (status.ok ? "Ready" : "Check: " + status.message) : "Missing";
        return `
          <article class="slot-card ${filledClass}" data-slot-import="${escapeHtml(slot.id)}">
            <div class="slot-head">
              <div class="slot-title">${escapeHtml(slot.label)}</div>
              <div class="slot-state">${escapeHtml(stateText)}</div>
            </div>
            <textarea spellcheck="false" data-slot-text="${escapeHtml(slot.id)}" placeholder="Paste copied ${escapeHtml(slot.label)} item here">${escapeHtml(value)}</textarea>
            <div class="slot-actions">
              <button type="button" data-paste-slot="${escapeHtml(slot.id)}">Paste Clipboard</button>
              <button type="button" data-clear-slot="${escapeHtml(slot.id)}">Clear</button>
            </div>
            <div class="hint">${escapeHtml(slot.label)} should come from an equipped ${slot.id === "chest" ? "body armour" : slotBase(slot.id)} item.</div>
          </article>
        `;
      }).join("");

      els.slotImportGrid.querySelectorAll("[data-slot-text]").forEach((textarea) => {
        textarea.addEventListener("input", () => {
          state.slotImports[textarea.getAttribute("data-slot-text")] = textarea.value;
          updateImportProgress();
          updateSlotCardStatus(textarea);
        });
        textarea.addEventListener("blur", () => updateSlotCardStatus(textarea));
      });
      els.slotImportGrid.querySelectorAll("[data-clear-slot]").forEach((button) => {
        button.addEventListener("click", () => {
          delete state.slotImports[button.getAttribute("data-clear-slot")];
          renderSlotImportGrid();
        });
      });
      els.slotImportGrid.querySelectorAll("[data-paste-slot]").forEach((button) => {
        button.addEventListener("click", async () => {
          const slotId = button.getAttribute("data-paste-slot");
          try {
            const text = await navigator.clipboard.readText();
            state.slotImports[slotId] = text || "";
            renderSlotImportGrid();
          } catch (err) {
            const card = button.closest(".slot-card");
            const textarea = card && card.querySelector("textarea");
            if (textarea) textarea.focus();
          }
        });
      });
    }

    // Relative "x ago" for a listing's index time, plus a staleness flag. PoE
    // re-indexes stashes periodically, so an old index time means the item is
    // more likely already sold/moved (the seller can still be online).
    function fmtAgo(value) {
      if (!value) return "";
      const t = new Date(value).getTime();
      if (isNaN(t)) return "";
      const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (sec < 60) return sec + "s ago";
      const min = Math.round(sec / 60);
      if (min < 60) return min + "m ago";
      const hr = Math.round(min / 60);
      if (hr < 24) return hr + "h ago";
      return Math.round(hr / 24) + "d ago";
    }
    function ageBucket(value) {
      const t = new Date(value || 0).getTime();
      if (isNaN(t) || !value) return "";
      const hours = (Date.now() - t) / 3600000;
      if (hours < 1) return "fresh";
      if (hours >= 12) return "stale";
      return "";
    }
    const SELLER_STATUS_LABEL = { online: "online", afk: "afk", dnd: "dnd", offline: "offline" };

    // European-style date/time display (DD/MM/YYYY, 24h) for trade-limit timestamps.
    function fmtEuTime(value) {
      if (value === "" || value === null || value === undefined) return "";
      const d = new Date(value);
      if (isNaN(d.getTime())) return String(value);
      return d.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    }

    async function refreshStatus() {
      try {
        const status = await api("/api/trade-status");
        const q = status.queue || {};
        els.status.innerHTML = status.limited
          ? `Trade queue: <b>limited</b><br>until ${escapeHtml(fmtEuTime(status.tradeLimitedUntil))}${status.secondsRemaining ? ` (${status.secondsRemaining}s)` : ""}`
          : `Trade queue: <b>ready</b><br>${q.queued || 0} queued / ${q.active || 0} active / ${q.minGapMs || 0}ms`;
      } catch (err) {
        els.status.innerHTML = `Trade queue: <b>offline</b>`;
      }
    }

    function renderSlots() {
      const slots = Object.keys(state.slots);
      els.slotSelect.innerHTML = slots.map((id) => `<option value="${id}">${escapeHtml(slotLabel(id))}</option>`).join("");
      els.slotSelect.value = state.selectedSlot;
    }

    function loadLockedItems() {
      try {
        const raw = JSON.parse(localStorage.getItem("poe2.gearSearch.lockedItems") || "{}") || {};
        const next = {};
        for (const [slotId, entry] of Object.entries(raw)) {
          const normalizedSlot = slotId === "ring" ? (next.ring1 ? "ring2" : "ring1") : slotId;
          next[normalizedSlot] = { ...entry, slot: normalizedSlot };
        }
        return next;
      } catch {
        return {};
      }
    }

    function saveLockedItems() {
      localStorage.setItem("poe2.gearSearch.lockedItems", JSON.stringify(state.lockedItems || {}));
    }

    function setImportOpen(open) {
      state.importOpen = !!open;
      els.importShell.classList.toggle("collapsed", !state.importOpen);
      els.importToggle.innerHTML = `<span class="glyph" aria-hidden="true">${state.importOpen ? "⌃" : "⌄"}</span>`;
      els.importToggle.setAttribute("aria-label", state.importOpen ? "Collapse gear import" : "Expand gear import");
      els.importToggle.title = state.importOpen ? "Collapse gear import" : "Expand gear import";
    }

    function currentDefaultFilters() {
      const item = currentItem();
      if (!item || !item.stats) return [];
      const slot = state.slots[state.selectedSlot] || {};
      return (slot.statKeys || [])
        .map((key) => ({ key, min: item.stats[key] }))
        .filter((filter) => Number.isFinite(Number(filter.min)));
    }

    function buildProjectedTotals() {
      const base = { ...(state.analysis && state.analysis.totals ? state.analysis.totals : {}) };
      for (const [slotId, locked] of Object.entries(state.lockedItems || {})) {
        const current = (state.analysis && state.analysis.equipped && state.analysis.equipped[slotId] && state.analysis.equipped[slotId].stats) || {};
        const candidate = locked.candidateStats || locked.stats || {};
        const next = replacementTotals(base, current, candidate);
        Object.keys(base).forEach((key) => delete base[key]);
        Object.assign(base, next);
      }
      return base;
    }

    function replacementTotals(totals, currentStats, candidateStats) {
      const next = { ...(totals || {}) };
      for (const [key, value] of Object.entries(currentStats || {})) next[key] = (next[key] || 0) - value;
      for (const [key, value] of Object.entries(candidateStats || {})) next[key] = (next[key] || 0) + value;
      return next;
    }

    function lockListing(listing) {
      const slotId = listing.slot || state.selectedSlot;
      if (!slotId) return;
      const existing = state.lockedItems[slotId];
      if (existing && existing.id === listing.id) {
        delete state.lockedItems[slotId];
      } else {
        state.lockedItems[slotId] = {
          id: listing.id,
          slot: slotId,
          name: listing.name,
          typeLine: listing.typeLine,
          priceDiv: listing.priceDiv,
          rawPrice: listing.rawPrice,
          seller: listing.seller,
          listedAt: listing.listedAt,
          candidateStats: listing.candidateStats || listing.stats || {},
          lockedAt: new Date().toISOString(),
        };
      }
      saveLockedItems();
      renderLockedPanel();
      if (state.result && state.result.slot === slotId) renderResults(state.result);
    }

    function renderLockedPanel() {
      const entries = Object.values(state.lockedItems || {}).sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
      if (!state.analysis || !entries.length) {
        els.lockedPanel.innerHTML = `<div class="empty">Lock candidate items to build a projected character overview.</div>`;
        return;
      }

      const currentTotals = state.analysis.totals || {};
      const projectedTotals = buildProjectedTotals();
      const deltas = statComparison(currentTotals, projectedTotals)
        .filter((stat) => stat.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || statDisplayRank(a.key) - statDisplayRank(b.key));
      const topGain = deltas.find((stat) => stat.delta > 0) || deltas[0] || null;
      const topLoss = deltas.find((stat) => stat.delta < 0) || null;
      const slotsLocked = entries.length;
      const currentTotalStats = Object.keys(currentTotals).length;

      const cards = entries.map((entry) => {
        const current = (state.analysis.equipped && state.analysis.equipped[entry.slot]) || null;
        const currentStats = current ? (current.stats || {}) : {};
        const candidateStats = entry.candidateStats || {};
        const compareRows = statComparison(currentStats, candidateStats, state.slots[entry.slot] ? state.slots[entry.slot].statKeys : [])
          .slice(0, 10)
          .map((stat) => {
            const cls = stat.delta > 0 ? "delta-pos" : stat.delta < 0 ? "delta-neg" : "";
            const sign = stat.delta > 0 ? "+" : "";
            return `<tr><td>${escapeHtml(stat.label)}</td><td>${fmt(stat.current)}</td><td>${fmt(stat.candidate)}</td><td class="${cls}">${sign}${fmt(stat.delta)}</td></tr>`;
          }).join("");
        return `
          <article class="lock-card">
            <div class="lock-card-head">
              <div>
                <div class="lock-title">${escapeHtml(slotLabel(entry.slot))}: ${escapeHtml(entry.name || "Locked item")}</div>
                <div class="lock-sub">${escapeHtml(entry.rawPrice || "-")} ${entry.seller ? " / " + escapeHtml(entry.seller) : ""}${entry.listedAt ? " / " + escapeHtml(entry.listedAt) : ""}</div>
              </div>
              <div class="lock-actions">
                <button class="lock-toggle active" type="button" data-lock-slot="${escapeHtml(entry.slot)}" data-lock-id="${escapeHtml(entry.id)}" title="Unlock item">
                  <span aria-hidden="true">🔒</span> Unlock
                </button>
              </div>
            </div>
            <div class="lock-sub">${escapeHtml(current ? (current.name || "Current item") : "No current item for this slot")} → ${escapeHtml(entry.name || "Locked item")}</div>
            <table class="comparison">
              <thead><tr><th>Stat</th><th>Current</th><th>Locked</th><th>Delta</th></tr></thead>
              <tbody>${compareRows || `<tr><td colspan="4" class="muted">No stats to show.</td></tr>`}</tbody>
            </table>
          </article>
        `;
      }).join("");

      const overviewRows = deltas.slice(0, 12).map((stat) => {
        const cls = stat.delta > 0 ? "delta-pos" : "delta-neg";
        const sign = stat.delta > 0 ? "+" : "";
        return `<tr><td>${escapeHtml(stat.label)}</td><td>${fmt(stat.current)}</td><td>${fmt(stat.candidate)}</td><td class="${cls}">${sign}${fmt(stat.delta)}</td></tr>`;
      }).join("") || `<tr><td colspan="4" class="muted">No projected changes.</td></tr>`;

      els.lockedPanel.innerHTML = `
        <div class="locked-summary">
          <div class="locked-card"><span class="label">Locked slots</span><b>${slotsLocked}</b></div>
          <div class="locked-card"><span class="label">Tracked stats</span><b>${currentTotalStats}</b></div>
          <div class="locked-card"><span class="label">Best gain</span><b>${topGain ? (topGain.delta > 0 ? "+" : "") + fmt(topGain.delta) : "-"}</b></div>
          <div class="locked-card"><span class="label">Worst loss</span><b>${topLoss ? (topLoss.delta > 0 ? "+" : "") + fmt(topLoss.delta) : "-"}</b></div>
        </div>
        <table class="projection-table">
          <thead><tr><th>Stat</th><th>Current</th><th>Projected</th><th>Delta</th></tr></thead>
          <tbody>${overviewRows}</tbody>
        </table>
        <div class="locked-grid">${cards}</div>
      `;

      els.lockedPanel.querySelectorAll("[data-lock-slot]").forEach((button) => {
        button.addEventListener("click", () => {
          const slotId = button.getAttribute("data-lock-slot");
          const id = button.getAttribute("data-lock-id");
          const entry = state.lockedItems[slotId];
          if (entry && entry.id === id) {
            delete state.lockedItems[slotId];
            saveLockedItems();
            renderLockedPanel();
            if (state.result) renderResults(state.result);
          }
        });
      });
    }

    function filterOptions(selected) {
      const slot = state.slots[state.selectedSlot] || {};
      const keys = Array.from(new Set([...(slot.statKeys || []), "life", "totalElementalRes", "fireRes", "coldRes", "lightningRes", "chaosRes", "rarity"]));
      return keys.map((key) => `<option value="${key}" ${key === selected ? "selected" : ""}>${escapeHtml(statOptionLabel(key))}</option>`).join("");
    }

    function statDisplayRank(key) {
      const order = [
        "dps",
        "projectileLevels",
        "spirit",
        "life",
        "totalLife",
        "energyShield",
        "totalEnergyShield",
        "evasion",
        "movementSpeed",
        "totalMovementSpeed",
        "localAttackSpeed",
        "attackSpeed",
        "localCritChance",
        "critChance",
        "attackCrit",
        "critDamage",
        "localPhysDamage",
        "flatPhys",
        "localFlatPhys",
        "localFlatCold",
        "localFlatFire",
        "localFlatLightning",
        "localFlatChaos",
        "totalFlatAttack",
        "totalFlatElementalAttack",
        "flatPhysAttack",
        "flatColdAttack",
        "flatFireAttack",
        "flatLightningAttack",
        "flatChaosAttack",
        "flatEle",
        "bowDamage",
        "projectileSpeed",
        "projectileDamage",
        "fireRes",
        "coldRes",
        "lightningRes",
        "totalElementalRes",
        "chaosRes",
        "totalResistance",
        "str",
        "totalStr",
        "dex",
        "totalDex",
        "int",
        "totalInt",
        "totalAllAttributes",
        "explicitAttributes",
        "rarity",
        "manaOnKill",
      ];
      const index = order.indexOf(key);
      return index === -1 ? order.length : index;
    }

    function statOptionLabel(key) {
      const labels = {
        dps: "DPS",
        localPhysDamage: "% increased physical damage",
        localFlatPhys: "Adds physical damage",
        localFlatCold: "Adds cold damage",
        localFlatFire: "Adds fire damage",
        localFlatLightning: "Adds lightning damage",
        localFlatChaos: "Adds chaos damage",
        totalFlatAttack: "Total flat damage",
        totalFlatElementalAttack: "Total elemental flat damage",
        localAttackSpeed: "Local attack speed",
        localCritChance: "Local critical chance",
        critChance: "Critical chance",
        attackSpeed: "Attack speed",
        projectileLevels: "Projectile skill levels",
        attackCrit: "Attack critical chance",
        critDamage: "Critical damage",
        bowDamage: "Bow skill damage",
        projectileSpeed: "Projectile speed",
        projectileDamage: "Projectile damage",
        deflection: "Deflection rating",
        flatPhysAttack: "Flat physical to attacks",
        flatColdAttack: "Flat cold to attacks",
        flatFireAttack: "Flat fire to attacks",
        flatLightningAttack: "Flat lightning to attacks",
        flatChaosAttack: "Flat chaos to attacks",
        life: "Maximum life",
        totalLife: "Total life",
        energyShield: "Energy shield",
        totalEnergyShield: "Total energy shield",
        evasion: "Evasion rating",
        movementSpeed: "Movement speed",
        totalMovementSpeed: "Total movement speed",
        totalElementalRes: "Total elemental res (sum)",
        fireRes: "Fire resistance",
        coldRes: "Cold resistance",
        lightningRes: "Lightning resistance",
        chaosRes: "Chaos resistance",
        totalResistance: "Total resistance (incl. chaos)",
        totalAllAttributes: "All attributes",
        explicitAttributes: "Explicit all attributes",
        str: "Strength",
        totalStr: "Total strength",
        dex: "Dexterity",
        totalDex: "Total dexterity",
        int: "Intelligence",
        totalInt: "Total intelligence",
        spirit: "Spirit",
        rarity: "Rarity",
        manaOnKill: "Mana on kill",
      };
      return labels[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (ch) => ch.toUpperCase());
    }

    function statComparison(currentStats, candidateStats, preferredKeys = []) {
      const keys = Array.from(new Set([
        ...preferredKeys,
        ...Object.keys(currentStats || {}),
        ...Object.keys(candidateStats || {}),
      ]))
        .filter((key) => {
          if (preferredKeys.includes(key)) return true; // Always include preferred keys
          return (Number(currentStats && currentStats[key]) || 0) || (Number(candidateStats && candidateStats[key]) || 0);
        })
        .sort((a, b) => statDisplayRank(a) - statDisplayRank(b) || a.localeCompare(b));
      return keys.map((key) => {
        const current = Math.round((Number(currentStats && currentStats[key]) || 0) * 100) / 100;
        const candidate = Math.round((Number(candidateStats && candidateStats[key]) || 0) * 100) / 100;
        return {
          key,
          label: statOptionLabel(key),
          current,
          candidate,
          delta: Math.round((candidate - current) * 100) / 100,
        };
      });
    }

    function addFilter(filter = {}) {
      const row = document.createElement("div");
      row.className = "filter-row";
      row.innerHTML = `
        <div><label>Stat</label><select class="filter-key">${filterOptions(filter.key)}</select></div>
        <div><label>Min</label><input class="filter-min" type="number" step="1" value="${filter.min ?? ""}"></div>
        <div><label>Max</label><input class="filter-max" type="number" step="1" value="${filter.max ?? ""}"></div>
        <button class="iconbtn" title="Remove filter" type="button">x</button>
      `;
      row.querySelector("button").addEventListener("click", () => { row.remove(); updatePreview(); });
      row.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", updatePreview));
      els.filters.appendChild(row);
    }

    function setDefaultFilters() {
      els.filters.innerHTML = "";
      for (const filter of currentDefaultFilters()) {
        addFilter({ key: filter.key, min: filter.min });
      }
    }

    const STAT_IDS = {
      projectileLevels: "explicit.stat_1202301673",
      attackCrit: "explicit.stat_2194114101",
      flatPhysAttack: "explicit.stat_3032590688",
      flatColdAttack: "explicit.stat_4067062424",
      flatFireAttack: "explicit.stat_1573130764",
      flatLightningAttack: "explicit.stat_1754445556",
      flatChaosAttack: "explicit.stat_674553446",
      attackSpeed: "explicit.stat_681332047",
      bowDamage: "explicit.stat_1241625305",
      projectileSpeed: "explicit.stat_3759663284",
      projectileDamage: "explicit.stat_1839076647",
      deflection: "explicit.stat_3040571529",
      spirit: "explicit.stat_3981240776",
      localPhysDamage: "explicit.stat_1509134228",
      localFlatPhys: "explicit.stat_1940865751",
      localFlatCold: "explicit.stat_1037193709",
      localFlatFire: "explicit.stat_709508406",
      localFlatLightning: "explicit.stat_3336890334",
      localFlatChaos: "explicit.stat_2223678961",
      localAttackSpeed: "explicit.stat_210067635",
      localCritChance: "explicit.stat_518292764",
      life: "explicit.stat_3299347043",
      energyShield: "pseudo.pseudo_total_energy_shield",
      coldRes: "explicit.stat_4220027924",
      lightningRes: "explicit.stat_1671376347",
      fireRes: "explicit.stat_3372524247",
      chaosRes: "explicit.stat_2923486259",
      totalElementalRes: "pseudo.pseudo_total_elemental_resistance",
      evasion: "explicit.stat_53045048",
      str: "explicit.stat_4080418644",
      dex: "explicit.stat_3261801346",
      int: "explicit.stat_328541901",
      totalAllAttributes: "pseudo.pseudo_total_all_attributes",
      movementSpeed: "explicit.stat_2250533757",
      critChance: "explicit.stat_587431675",
      critDamage: "explicit.stat_3556824919",
      rarity: "explicit.stat_3917489142",
      manaOnKill: "explicit.stat_1368271171",
    };

    function collectFilters() {
      return Array.from(els.filters.querySelectorAll(".filter-row")).map((row) => ({
        key: row.querySelector(".filter-key").value,
        min: row.querySelector(".filter-min").value === "" ? undefined : Number(row.querySelector(".filter-min").value),
        max: row.querySelector(".filter-max").value === "" ? undefined : Number(row.querySelector(".filter-max").value),
      })).filter((item) => item.key);
    }

    function requestPayload(previewOnly = false) {
      return {
        league: "Runes of Aldur",
        slot: state.selectedSlot,
        current: currentItem(),
        maxPriceDiv: Number(els.budget.value) || 0,
        matchMode: els.matchMode.value,
        minMatches: els.matchMode.value === "count" ? (Number(els.minMatches.value) || 1) : undefined,
        filters: collectFilters(),
        previewOnly,
      };
    }

    async function updatePreview() {
      if (!Object.keys(state.slots).length) return;
      try {
        const result = await api("/api/gear-search/search", requestPayload(true));
        const warnings = [];
        if (result.unsupportedFilters && result.unsupportedFilters.length) {
          warnings.push("Unsupported filters not sent: " + result.unsupportedFilters.join(", "));
        }
        if ((result.compositeFilters || []).some((filter) => filter.postValue)) {
          warnings.push("Combined flat damage filters use a broad prefilter (any of the components) on the Trade site and are strictly summed locally. We fetch extra items to find the best matches.");
        }
        const warning = warnings.length ? warnings.join("\n") + "\n\n" : "";
        els.queryPreview.textContent = warning + JSON.stringify(result.query, null, 2);
        renderSummary(result);
      } catch (err) {
        els.queryPreview.textContent = err.message;
      }
    }

    function renderSummary(result = state.result || {}) {
      els.summary.innerHTML = `
        <div class="metric"><span class="muted">Selected</span><b>${escapeHtml(slotLabel(state.selectedSlot))}</b></div>
        <div class="metric"><span class="muted">Budget</span><b>${fmt(els.budget.value)} div</b></div>
        <div class="metric"><span class="muted">Total</span><b>${result.total ?? "-"}</b></div>
        <div class="metric"><span class="muted">Fetched</span><b>${result.fetched ?? "-"}</b></div>
      `;
    }

    function renderResults(result) {
      state.result = result;
      renderSummary(result);
      if (result.limited) {
        els.results.innerHTML = `<div class="empty">Trade2 is rate limited until ${escapeHtml(fmtEuTime(result.tradeStatus && result.tradeStatus.tradeLimitedUntil))}.</div>`;
        return;
      }
      if (!result.listings || !result.listings.length) {
        const link = result.url ? `<div class="actions" style="margin-top:10px"><a class="primary" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">Open Trade</a></div>` : "";
        els.results.innerHTML = `<div class="empty">No priced listings returned.${link}</div>`;
        return;
      }
      const open = result.url ? `<a class="primary" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">Open Trade</a>` : "";
      els.results.innerHTML = `<div class="actions">${open}</div>` + result.listings.map((item) => {
        const isLocked = !!(state.lockedItems && state.lockedItems[item.slot] && state.lockedItems[item.slot].id === item.id);
        const rows = (item.comparison || [])
          .slice(0, 10)
          .map((stat) => {
            const cls = stat.delta > 0 ? "delta-pos" : stat.delta < 0 ? "delta-neg" : "";
            const sign = stat.delta > 0 ? "+" : "";
            return `<tr><td>${escapeHtml(stat.label)}</td><td>${fmt(stat.current)}</td><td>${fmt(stat.candidate)}</td><td class="${cls}">${sign}${fmt(stat.delta)}</td></tr>`;
          }).join("");
        return `
          <article class="listing">
            <div class="listing-head">
              <div>
                <div class="listing-title">${escapeHtml(item.name)}</div>
                <div class="muted">
                  ${item.sellerStatus ? `<span class="badge ${escapeHtml(item.sellerStatus)}" title="Seller account status (not item availability)">${escapeHtml(SELLER_STATUS_LABEL[item.sellerStatus] || item.sellerStatus)}</span>` : ""}
                  ${escapeHtml(item.seller || "unknown seller")}
                  ${item.listedAt ? `<span class="badge ${ageBucket(item.listedAt)}" title="Listed ${escapeHtml(fmtEuTime(item.listedAt))} — older listings are more likely stale">${escapeHtml(fmtAgo(item.listedAt))}</span>` : ""}
                </div>
              </div>
              <div class="lock-actions">
                <div class="price">${escapeHtml(item.rawPrice)}<br><span class="muted">${fmt(item.priceDiv || 0)} div</span></div>
                ${item.tradeSpec ? `<button class="view-trade" type="button" data-listing-view="${escapeHtml(item.id)}" data-listing-slot="${escapeHtml(item.slot)}" title="Open this item in the official PoE2 Trade UI">View on Trade</button>` : ""}
                <button class="lock-toggle ${isLocked ? "active" : ""}" type="button" data-listing-lock="${escapeHtml(item.id)}" data-listing-slot="${escapeHtml(item.slot)}" title="${isLocked ? "Unlock item" : "Lock item"}">
                  <span aria-hidden="true">${isLocked ? "🔒" : "🔓"}</span>${isLocked ? "Unlock" : "Lock"}
                </button>
              </div>
            </div>
            <table class="comparison">
              <thead><tr><th>Stat</th><th>Current</th><th>Candidate</th><th>Delta</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="4" class="muted">No stats to show.</td></tr>`}</tbody>
            </table>
          </article>
        `;
      }).join("");
      els.results.querySelectorAll("[data-listing-lock]").forEach((button) => {
        button.addEventListener("click", () => {
          const slot = button.getAttribute("data-listing-slot");
          const id = button.getAttribute("data-listing-lock");
          const listing = (result.listings || []).find((item) => item.slot === slot && item.id === id);
          if (listing) lockListing(listing);
        });
      });
      els.results.querySelectorAll("[data-listing-view]").forEach((button) => {
        button.addEventListener("click", async () => {
          const slot = button.getAttribute("data-listing-slot");
          const id = button.getAttribute("data-listing-view");
          const listing = (result.listings || []).find((item) => item.slot === slot && item.id === id);
          if (!listing || !listing.tradeSpec) return;
          // Open the tab synchronously so the popup blocker allows it, then
          // point it at the search the server builds for this single item.
          const win = window.open("", "_blank");
          const original = button.textContent;
          button.disabled = true;
          button.textContent = "Opening...";
          try {
            const data = await api("/api/gear-search/listing-link", { spec: listing.tradeSpec, league: result.league });
            if (data.limited) {
              if (win) win.close();
              button.textContent = "Rate limited";
            } else if (data.url) {
              if (win) { win.location = data.url; } else { window.open(data.url, "_blank"); }
              button.textContent = "Opened";
            } else {
              if (win) win.close();
              button.textContent = "No link";
            }
          } catch (err) {
            if (win) win.close();
            button.textContent = "Failed";
          } finally {
            button.disabled = false;
            setTimeout(() => { button.textContent = original; }, 1500);
            refreshStatus();
          }
        });
      });
    }

    async function analyze() {
      syncRawFromSlots();
      const data = await api("/api/gear-search/analyze", { text: els.gearText.value });
      state.analysis = data;
      state.slots = data.slots || {};
      const firstEquipped = Object.keys(data.equipped || {})[0];
      state.selectedSlot = state.selectedSlot && data.equipped[state.selectedSlot] ? state.selectedSlot : (firstEquipped || "bow");
      renderSlots();
      setDefaultFilters();
      renderLockedPanel();
      setImportOpen(false);
      await updatePreview();
    }

    async function importExport() {
      const data = await api("/api/gear-search/import-browser-export", { text: els.gearText.value });
      els.gearText.value = data.text || "";
      hydrateSlotImports(data.text || "");
      state.analysis = data.analysis;
      state.slots = data.analysis.slots || {};
      state.selectedSlot = Object.keys(data.analysis.equipped || {})[0] || "bow";
      renderSlots();
      setDefaultFilters();
      renderLockedPanel();
      setImportOpen(false);
      await updatePreview();
    }

    async function search() {
      els.results.innerHTML = `<div class="empty">Searching Trade2 through the shared queue...</div>`;
      const result = await api("/api/gear-search/search", requestPayload(false));
      const warnings = [];
      if ((result.compositeFilters || []).some((filter) => filter.postValue)) {
        warnings.push("Combined flat damage filters use a broad prefilter (any of the components) on the Trade site and are strictly summed locally. We fetch extra items to find the best matches.");
      }
      els.queryPreview.textContent = (warnings.length ? warnings.join("\n") + "\n\n" : "") + JSON.stringify(result.query || {}, null, 2);
      renderResults(result);
      refreshStatus();
    }

    state.lockedItems = loadLockedItems();
    els.consoleSnippet.textContent = CONSOLE_EXPORT_SNIPPET;
    renderImportProfiles();
    renderSlotImportGrid();
    setImportOpen(true);
    els.importToggle.addEventListener("click", () => setImportOpen(!state.importOpen));
    document.getElementById("analyzeBtn").addEventListener("click", () => analyze().catch((err) => els.results.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`));
    document.getElementById("importBtn").addEventListener("click", () => importExport().catch((err) => els.results.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`));
    document.getElementById("syncSlotsBtn").addEventListener("click", () => hydrateSlotImports(els.gearText.value || ""));
    document.getElementById("copyConsoleBtn").addEventListener("click", async () => {
      const button = document.getElementById("copyConsoleBtn");
      try {
        await navigator.clipboard.writeText(CONSOLE_EXPORT_SNIPPET);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy Failed";
      }
      setTimeout(() => { button.textContent = "Copy Console Code"; }, 1400);
    });
    document.getElementById("searchBtn").addEventListener("click", () => search().catch((err) => els.results.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`));
    document.getElementById("addFilterBtn").addEventListener("click", () => { addFilter(); updatePreview(); });
    document.getElementById("saveBtn").addEventListener("click", saveCurrentImportProfile);
    document.getElementById("loadBtn").addEventListener("click", () => loadSelectedImportProfile().catch((err) => els.results.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`));
    document.getElementById("deleteSaveBtn").addEventListener("click", deleteSelectedImportProfile);
    els.importProfileSelect.addEventListener("change", () => {
      els.importSaveName.value = selectedImportProfileName();
    });
    els.slotSelect.addEventListener("change", () => { state.selectedSlot = els.slotSelect.value; setDefaultFilters(); updatePreview(); });
    [els.budget, els.matchMode, els.minMatches].forEach((el) => el.addEventListener("input", updatePreview));

    refreshStatus();
    setInterval(refreshStatus, 15000);
    const profiles = loadImportProfiles();
    const firstProfile = Object.keys(profiles).sort((a, b) => a.localeCompare(b))[0] || "";
    const saved = (firstProfile && profiles[firstProfile] ? profiles[firstProfile].text : "") || localStorage.getItem(IMPORT_TEXT_KEY) || localStorage.getItem("poe2.upgradeFinder.gearText") || "";
    if (saved) {
      els.gearText.value = saved;
      if (firstProfile) {
        els.importSaveName.value = firstProfile;
        renderImportProfiles(firstProfile);
      }
      hydrateSlotImports(saved);
      analyze().catch(() => {});
    } else {
      api("/api/gear-search/analyze", { text: "" }).then((data) => {
        state.analysis = data;
        state.slots = data.slots || {};
        renderSlots();
        setDefaultFilters();
        renderLockedPanel();
        updatePreview();
      }).catch(() => {});
    }
  
};
