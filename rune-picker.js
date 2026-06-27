/* Rune Picker — inlined view, lazy-init on first open (registers in __viewInit). */
window.__viewInit = window.__viewInit || {};
window.__viewInit["rune-picker"] = function () {
  const runeLeagueInput = document.getElementById("runeLeague");
  const runeInput = document.getElementById("runeInput");
  const runeStatus = document.getElementById("runeStatus");
  const runeRows = document.getElementById("runeRows");
  const runeBest = document.getElementById("runeBest");
  const checkRunesBtn = document.getElementById("checkRunes");
  const freshRunesBtn = document.getElementById("freshRunes");
  const pasteRunesBtn = document.getElementById("pasteRunes");
  let tradeLimitedUntil = 0;
  let tradeStatusTimer = 0;
  let runeResultData = [];
  let tradeQueueRunning = false;

  // Sort state. Default = confidence tier first, then value (total), descending —
  // so the most reliable high-value picks float to the top. Headers are clickable
  // to re-sort by any column (click again to flip direction).
  const CONF_RANK = { base: 3, high: 3, medium: 2, low: 1, none: 0, unknown: 0 };
  const TH_LABELS = { qty: "Qty", name: "Name", category: "Category", each: "Each", total: "Total", conf: "Conf", source: "Source", change7d: "7d" };
  let sortKey = "conf", sortDir = -1;   // -1 = descending, 1 = ascending

  function fx(v){
    if(typeof v!=="number"||!isFinite(v)) return esc(v||"");
    if(v>=10) return Math.round(v)+" ex";
    if(v>=1) return v.toFixed(2)+" ex";
    if(v>=0.01) return v.toFixed(4)+" ex";
    if(v>=0.0001) return v.toFixed(4)+" ex";
    return "<0.0001 ex";
  }
  function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
  function confBadge(item){
    const map={high:["conf-hi","High"],medium:["conf-md","Med"],low:["conf-lo","Low"],none:["conf-no","None"],base:["conf-hi","Base"]};
    const m=map[item.confidence]||["conf-unk","—"];
    const u=(typeof item.units==="number")?item.units:null;
    const tip=item.confidence==="base"
      ?"Base currency — 1 ex by definition (the unit every price is quoted in). Not scanned."
      :u!=null
        ?"~"+u+" units traded on poe.ninja (7d). More = deeper market, more reliable price."
        :"No liquidity data from poe.ninja.";
    const suffix=(u!=null&&item.confidence!=="high")?" "+u:"";
    return '<span class="conf '+m[0]+'" title="'+esc(tip)+'">'+m[1]+suffix+'</span>';
  }
  function setRuneStatus(text,kind){runeStatus.textContent=text;runeStatus.className="status "+(kind||"")}

  function confRank(it){ return CONF_RANK[it.confidence] != null ? CONF_RANK[it.confidence] : 0; }
  function numv(v){ const n=Number(v); return isFinite(n)?n:-1; }
  function sortedRows(){
    return runeResultData.slice().sort((a,b)=>{
      let r;
      if(sortKey==="conf") r=(confRank(a)-confRank(b))||(numv(a.total)-numv(b.total));
      else if(sortKey==="qty") r=numv(a.qty)-numv(b.qty);
      else if(sortKey==="each") r=numv(a.each)-numv(b.each);
      else if(sortKey==="total") r=numv(a.total)-numv(b.total);
      else if(sortKey==="change7d") r=(parseFloat(a.change7d)||0)-(parseFloat(b.change7d)||0);
      else r=String(a[sortKey]||"").toLowerCase().localeCompare(String(b[sortKey]||"").toLowerCase());
      return r*sortDir;
    });
  }
  function updateSortIndicators(){
    document.querySelectorAll(".toolroot-rune thead th[data-sort]").forEach(th=>{
      const k=th.getAttribute("data-sort"), active=k===sortKey;
      th.classList.toggle("sorted",active);
      th.innerHTML=esc(TH_LABELS[k]||k)+(active?' <span class="sort-arrow">'+(sortDir<0?"▼":"▲")+"</span>":"");
    });
  }

  // European-style date/time display (DD/MM/YYYY, 24h) for trade-limit timestamps.
  function fmtEuTime(value){
    if(value===""||value===null||value===undefined) return "";
    const d=new Date(value);
    if(isNaN(d.getTime())) return String(value);
    return d.toLocaleString("en-GB",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
  }

  function updateTradeLimitUi(){
    const remaining=Math.ceil((tradeLimitedUntil-Date.now())/1000);
    if(remaining>0){
      const until=fmtEuTime(tradeLimitedUntil);
      setRuneStatus("Trade2 limited until "+until+" ("+remaining+"s). Trade queue waits; poe.ninja checks still work.", "err");
      return true;
    }
    tradeLimitedUntil=0;
    return false;
  }

  function setTradeLimit(iso){
    tradeLimitedUntil=iso?new Date(iso).getTime():0;
    clearInterval(tradeStatusTimer);
    if(updateTradeLimitUi()){
      tradeStatusTimer=setInterval(()=>{
        if(!updateTradeLimitUi()){
          clearInterval(tradeStatusTimer);
          setRuneStatus("Trade2 cooldown cleared. You can check picks again.", "ok");
        }
      },1000);
    }
  }

  async function refreshTradeStatus(){
    try{
      const r=await fetch("/api/trade-status");
      if(!r.ok) return false;
      const data=await r.json();
      setTradeLimit(data.tradeLimitedUntil||"");
      return Boolean(data.limited);
    }catch{
      return false;
    }
  }

  function renderRows(){
    if(!runeResultData.length){
      runeRows.innerHTML='<tr><td colspan="8" class="muted">No results yet — check the pasted text and Evaluate again.</td></tr>';
      updateSortIndicators();
      return;
    }
    runeRows.innerHTML=sortedRows().map((item)=>{
      const missing=!item.total;
      return '<tr>'+
        '<td class="num">'+esc(item.qty)+'</td>'+
        '<td>'+esc(item.name)+'</td>'+
        '<td>'+esc(item.category||"")+'</td>'+
        '<td class="num">'+(missing?"":fx(item.each))+(item.sideLine?'<div class="muted sides" title="cheapest exchange offer on each currency side, like Exiled Exchange 2">'+esc(item.sideLine)+'</div>':'')+'</td>'+
        '<td class="num">'+(missing?"":fx(item.total))+'</td>'+
        '<td>'+confBadge(item)+'</td>'+
        '<td>'+esc(item.source||"")+(item.rawPrice?'<div class="muted">'+esc(item.rawPrice)+'</div>':'')+'</td>'+
        '<td class="num">'+esc(item.change7d||"")+'</td>'+
      '</tr>';
    }).join("");
    updateSortIndicators();
  }

  function renderRuneResults(data){
    runeResultData=data.results||[];
    if(!runeResultData.length){
      runeBest.className="bestbox empty";
      runeBest.textContent="No priced picks yet — paste reward lines or item choices above, then Evaluate.";
      renderRows();
      return;
    }

    const best=data.best||runeResultData.find(item=>Number(item.total)>0);
    if(best){
      runeBest.className="bestbox";
      runeBest.innerHTML='<b>Best pick: '+esc(best.qty)+'x '+esc(best.name)+'</b><span>'+fx(best.total)+' total / '+fx(best.each)+' each - '+esc(best.category)+' via '+esc(best.source)+'</span>'+(best.rawPrice?'<div class="muted">Raw listing: '+esc(best.rawPrice)+'</div>':'');
    }else{
      runeBest.className="bestbox empty";
      runeBest.textContent="No priced picks yet — paste reward lines or item choices above, then Evaluate.";
    }

    renderRows();
  }

  function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

  function bestFromResults(results){
    return results.filter(item=>Number(item.total)>0).sort((a,b)=>Number(b.total)-Number(a.total))[0]||null;
  }

  async function waitForTradeCooldown(){
    while(await refreshTradeStatus()){
      const waitMs=Math.max(1000,tradeLimitedUntil-Date.now()+500);
      await sleep(waitMs);
    }
  }

  async function processTradeQueue(results,league){
    if(tradeQueueRunning) return;
    tradeQueueRunning=true;
    try{
      const queued=results.map((item,index)=>({item,index})).filter(entry=>entry.item.category==="Trade queued");
      for(let q=0;q<queued.length;q++){
        const {item}=queued[q];
        await waitForTradeCooldown();
        setRuneStatus("Checking trade row "+(q+1)+" of "+queued.length+": "+item.name, "");
        const r=await fetch("/api/trade-price",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({league,name:item.name,qty:item.qty})
        });
        if(!r.ok) throw new Error("trade endpoint returned HTTP "+r.status);
        const data=await r.json();
        if(data.limited){
          setTradeLimit(data.tradeLimitedUntil);
          q--;
          continue;
        }
        if(data.found){
          Object.assign(item,data);
        }else{
          Object.assign(item,{category:"Not found",each:"",total:"",source:"trade2",rawPrice:""});
        }
        renderRuneResults({results,best:bestFromResults(results)});
      }
      setRuneStatus("Checked "+results.length+" picks. Trade queue complete.", "ok");
    }catch(err){
      setRuneStatus("Trade queue stopped: "+err.message, "err");
    }finally{
      tradeQueueRunning=false;
    }
  }

  // Auto-fill: exchange items show "pricing…" while the background book fill runs.
  // Re-poll the (cheap, cached) endpoint so prices appear WITHOUT re-clicking, and
  // surface progress in the shared top bar. Bounded so it can't hammer the queue.
  const AUTO_POLL_MS=7000, AUTO_POLL_MAX=10;
  let autoPollTimer=0, autoPolls=0;
  function pendingCount(){ return (runeResultData||[]).filter(r=>/pricing/i.test(r.category||"")).length; }
  function stopAutoPoll(){ if(autoPollTimer){clearTimeout(autoPollTimer);autoPollTimer=0;} autoPolls=0; if(window.__bg) window.__bg.clear("rune-picker"); }
  function scheduleAutoPoll(text,league){
    const pending=pendingCount(), total=(runeResultData||[]).length||1, done=total-pending;
    if(!pending){
      if(window.__bg && autoPolls>0) window.__bg.set("rune-picker","Rune Picker · priced "+total,1,"done");
      autoPollTimer=0; autoPolls=0; return;
    }
    if(autoPolls>=AUTO_POLL_MAX){
      setRuneStatus(pending+" still pricing — Trade2 is slow; click Evaluate to keep filling.","");
      if(window.__bg) window.__bg.clear("rune-picker"); autoPollTimer=0; autoPolls=0; return;
    }
    setRuneStatus("Pricing "+pending+" item"+(pending>1?"s":"")+" from Trade2 — auto-updating… ("+done+"/"+total+" priced)","");
    if(window.__bg) window.__bg.set("rune-picker","Rune Picker · pricing "+pending+" left",done/total,"active");
    autoPollTimer=setTimeout(async()=>{
      autoPolls++;
      try{
        const data=await fetch("/api/rune-prices",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,league,forceFresh:false})}).then(r=>r.json());
        if(data && (data.results||[]).length) renderRuneResults(data);
        scheduleAutoPoll(text,league);
      }catch{ stopAutoPoll(); }
    },AUTO_POLL_MS);
  }

  async function checkRunes(forceFresh){
    stopAutoPoll();
    await refreshTradeStatus();
    if(tradeQueueRunning){
      setRuneStatus("Trade queue is already running. Wait for it to finish or refresh to start over.", "err");
      return;
    }
    const text=runeInput.value.trim();
    const league=runeLeagueInput.value.trim()||"Runes of Aldur";
    if(!text){
      setRuneStatus("Paste item names first.", "err");
      return;
    }
    checkRunesBtn.disabled=true;
    freshRunesBtn.disabled=true;
    pasteRunesBtn.disabled=true;
    if(forceFresh) freshRunesBtn.classList.add("loading");
    setRuneStatus(forceFresh?"Fetching fresh Trade2 prices for the pasted items... (can take ~15s)":"Pricing pasted choices...", "");
    try{
      const r=await fetch("/api/rune-prices",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({text,league,forceFresh:!!forceFresh})
      });
      if(!r.ok) throw new Error("local server returned HTTP "+r.status);
      const data=await r.json();
      renderRuneResults(data);
      const queued=(data.results||[]).filter(item=>item.category==="Trade queued").length;
      const limited=data.tradeLimitedUntil?" Trade2 limited until "+fmtEuTime(data.tradeLimitedUntil)+".":"";
      const freshNote=forceFresh?" (fresh Trade2 prices)":"";
      setRuneStatus("Checked "+data.count+" picks"+freshNote+(queued?"; "+queued+" trade rows queued":"")+(data.truncated?" (first 30 lines only)":"")+"."+limited, data.tradeLimitedUntil?"err":"ok");
      if(data.tradeLimitedUntil) setTradeLimit(data.tradeLimitedUntil);
      if(queued) processTradeQueue(data.results,league);
      scheduleAutoPoll(text,league);   // keep filling "pricing…" items hands-free
    }catch(err){
      setRuneStatus("Rune check failed: "+err.message, "err");
    }finally{
      checkRunesBtn.disabled=false;
      freshRunesBtn.disabled=false;
      pasteRunesBtn.disabled=false;
      freshRunesBtn.classList.remove("loading");
    }
  }

  async function pasteRunes(){
    try{
      if(!navigator.clipboard||!navigator.clipboard.readText) throw new Error("clipboard permission is unavailable");
      runeInput.value=await navigator.clipboard.readText();
      setRuneStatus("Clipboard pasted. Run a check when ready.", "ok");
    }catch(err){
      setRuneStatus("Paste manually: "+err.message, "err");
      runeInput.focus();
    }
  }

  const pasteZoneEl=document.getElementById("pasteZone");
  const pasteZoneLabelEl=document.getElementById("pasteZoneLabel");
  const pastePreviewEl=document.getElementById("pastePreview");

  function setPasteZoneState(state, label){
    pasteZoneEl.className="paste-zone"+(state?" "+state:"");
    if(label) pasteZoneLabelEl.textContent=label;
  }

  async function ocrImage(blob){
    const url=URL.createObjectURL(blob);
    pastePreviewEl.src=url;
    pastePreviewEl.style.display="block";
    setPasteZoneState("ocr-running","Running OCR...");
    setRuneStatus("Running OCR on screenshot...", "");
    try{
      const r=await fetch("/api/ocr",{method:"POST",headers:{"Content-Type":blob.type||"image/png"},body:blob});
      if(!r.ok){
        const j=await r.json().catch(()=>({error:"OCR request failed (HTTP "+r.status+")"}));
        throw new Error(j.error||"OCR failed");
      }
      const data=await r.json();
      if(!data.text) throw new Error("No text found in image");
      runeInput.value=data.text;
      setPasteZoneState("ocr-ok","OCR done — review text then hit Evaluate");
      setRuneStatus("Text extracted. Review the lines and click Evaluate.", "ok");
    }catch(err){
      setPasteZoneState("ocr-err","OCR failed: "+err.message);
      setRuneStatus("OCR failed: "+err.message, "err");
    }
  }

  function handleImageFile(file){
    if(!file||!file.type.startsWith("image/")) return;
    ocrImage(file);
  }

  document.addEventListener("paste",(e)=>{
    const items=[...(e.clipboardData?.items||[])];
    const img=items.find(i=>i.type.startsWith("image/"));
    if(img){e.preventDefault();handleImageFile(img.getAsFile());}
  });

  pasteZoneEl.addEventListener("dragover",(e)=>{e.preventDefault();pasteZoneEl.classList.add("drag-over");});
  pasteZoneEl.addEventListener("dragleave",()=>pasteZoneEl.classList.remove("drag-over"));
  pasteZoneEl.addEventListener("drop",(e)=>{
    e.preventDefault();
    pasteZoneEl.classList.remove("drag-over");
    const file=e.dataTransfer?.files[0];
    if(file) handleImageFile(file);
  });

  pasteZoneEl.addEventListener("click",()=>{
    const inp=document.createElement("input");
    inp.type="file";inp.accept="image/*";
    inp.onchange=()=>{if(inp.files[0]) handleImageFile(inp.files[0]);};
    inp.click();
  });

  document.querySelectorAll(".toolroot-rune thead th[data-sort]").forEach(th=>{
    th.addEventListener("click",()=>{
      const k=th.getAttribute("data-sort");
      if(sortKey===k) sortDir=-sortDir;
      else { sortKey=k; sortDir=(k==="name"||k==="category"||k==="source")?1:-1; }  // text cols default A→Z, numeric/conf high→low
      renderRows();
    });
  });
  updateSortIndicators();

  checkRunesBtn.addEventListener("click",()=>checkRunes(false));
  freshRunesBtn.addEventListener("click",()=>checkRunes(true));
  pasteRunesBtn.addEventListener("click",pasteRunes);

  // ── poe.ninja currency-exchange prices (browser bridge) ───────────────────
  // poe.ninja's PoE2 API is Cloudflare-blocked server-side, so the user runs this
  // snippet in their own browser ON poe.ninja (CF-cleared, same-origin) to copy the
  // currency-exchange prices, then pastes them here → /api/currency-overrides. The
  // `\t`/`\n` are intentionally escaped so the COPIED code contains real escapes.
  const NINJA_SNIPPET = `(async()=>{try{
var slug=location.pathname.split('/')[3]||'standard';
var small={of:1,the:1,a:1,and:1,to:1,in:1};
var league=slug.split('-').map(function(w,i){return (i>0&&small[w])?w:w.charAt(0).toUpperCase()+w.slice(1);}).join(' ');
var r=await fetch('/poe2/api/economy/currencyexchange/overview?leagueName='+encodeURIComponent(league)+'&overviewName=Currency',{credentials:'include'});
if(!r.ok){console.log('poe.ninja fetch failed '+r.status+' for "'+league+'" — open your league\\'s Currency page first');return;}
var d=await r.json();var L={};(d.lines||[]).forEach(function(l){L[l.id]=l;});
var out=(d.items||[]).map(function(it){var l=L[it.id]||{};var v=(l.primaryValue!=null?l.primaryValue:l.secondaryValue);return v>0?it.name+'\\t'+v:null;}).filter(Boolean).join('\\n');
await navigator.clipboard.writeText(out);
console.log('Copied '+out.split('\\n').length+' poe.ninja prices for "'+league+'". Paste them into the Rune Picker.');
}catch(e){console.log('snippet error: '+e.message);}})();`;

  async function copyToClipboard(txt){
    try{ if(navigator.clipboard && window.isSecureContext){ await navigator.clipboard.writeText(txt); return true; } }catch{}
    const ta=document.createElement("textarea"); ta.value=txt; ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok=false; try{ ok=document.execCommand("copy"); }catch{} ta.remove(); return ok;
  }
  const ninjaCopyBtn=document.getElementById("ninjaCopySnippet");
  const ninjaSaveBtn=document.getElementById("ninjaSave");
  const ninjaPasteEl=document.getElementById("ninjaPaste");
  const ninjaStatusEl=document.getElementById("ninjaStatus");
  function setNinjaStatus(t,k){ if(ninjaStatusEl){ ninjaStatusEl.textContent=t; ninjaStatusEl.className="status "+(k||""); } }
  if(ninjaCopyBtn) ninjaCopyBtn.addEventListener("click", async ()=>{
    const ok=await copyToClipboard(NINJA_SNIPPET);
    ninjaCopyBtn.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(()=>{ ninjaCopyBtn.textContent="Copy snippet"; }, 1400);
  });
  if(ninjaSaveBtn) ninjaSaveBtn.addEventListener("click", async ()=>{
    const text=(ninjaPasteEl.value||"").trim();
    if(!text){ setNinjaStatus("Paste the prices the snippet copied first.","err"); return; }
    try{
      const r=await fetch("/api/currency-overrides",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
      const d=await r.json();
      setNinjaStatus("Saved "+(d.saved||0)+" prices"+(runeInput.value.trim()?" — re-checking…":"."),"ok");
      if(runeInput.value.trim()) checkRunes(false);
    }catch(err){ setNinjaStatus("Save failed: "+err.message,"err"); }
  });

  refreshTradeStatus();
};
