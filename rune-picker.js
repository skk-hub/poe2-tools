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

  function renderRuneResults(data){
    runeResultData=data.results||[];
    if(!data.results||!data.results.length){
      runeBest.className="bestbox empty";
      runeBest.textContent="No priced picks yet.";
      runeRows.innerHTML='<tr><td colspan="8" class="muted">No results. Check the pasted text.</td></tr>';
      return;
    }

    const best=data.best||data.results.find(item=>Number(item.total)>0);
    if(best){
      runeBest.className="bestbox";
      runeBest.innerHTML='<b>Best pick: '+esc(best.qty)+'x '+esc(best.name)+'</b><span>'+fx(best.total)+' total / '+fx(best.each)+' each - '+esc(best.category)+' via '+esc(best.source)+'</span>'+(best.rawPrice?'<div class="muted">Raw listing: '+esc(best.rawPrice)+'</div>':'');
    }else{
      runeBest.className="bestbox empty";
      runeBest.textContent="No priced picks yet.";
    }

    runeRows.innerHTML=data.results.map((item,index)=>{
      const missing=!item.total;
      return '<tr id="rune-row-'+index+'">'+
        '<td class="num">'+esc(item.qty)+'</td>'+
        '<td>'+esc(item.name)+'</td>'+
        '<td>'+esc(item.category||"")+'</td>'+
        '<td class="num">'+(missing?"":fx(item.each))+'</td>'+
        '<td class="num">'+(missing?"":fx(item.total))+'</td>'+
        '<td>'+confBadge(item)+'</td>'+
        '<td>'+esc(item.source||"")+(item.rawPrice?'<div class="muted">'+esc(item.rawPrice)+'</div>':'')+'</td>'+
        '<td class="num">'+esc(item.change7d||"")+'</td>'+
      '</tr>';
    }).join("");
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
      const queued=results.map((item,index)=>({item,index})).filter(entry=>entry.item.category==="TRADE QUEUED");
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
          Object.assign(item,{category:"NOT FOUND",each:"",total:"",source:"trade2",rawPrice:""});
        }
        results.sort((a,b)=>(Number(b.total)||-1)-(Number(a.total)||-1));
        renderRuneResults({results,best:bestFromResults(results)});
      }
      setRuneStatus("Checked "+results.length+" picks. Trade queue complete.", "ok");
    }catch(err){
      setRuneStatus("Trade queue stopped: "+err.message, "err");
    }finally{
      tradeQueueRunning=false;
    }
  }

  async function checkRunes(forceFresh){
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
      const queued=(data.results||[]).filter(item=>item.category==="TRADE QUEUED").length;
      const limited=data.tradeLimitedUntil?" Trade2 limited until "+fmtEuTime(data.tradeLimitedUntil)+".":"";
      const freshNote=forceFresh?" (fresh Trade2 prices)":"";
      setRuneStatus("Checked "+data.count+" picks"+freshNote+(queued?"; "+queued+" trade rows queued":"")+(data.truncated?" (first 30 lines only)":"")+"."+limited, data.tradeLimitedUntil?"err":"ok");
      if(data.tradeLimitedUntil) setTradeLimit(data.tradeLimitedUntil);
      if(queued) processTradeQueue(data.results,league);
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
      setPasteZoneState("ocr-ok","OCR done — review text then hit Check picks");
      setRuneStatus("Text extracted. Review the lines and click Check picks.", "ok");
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

  checkRunesBtn.addEventListener("click",()=>checkRunes(false));
  freshRunesBtn.addEventListener("click",()=>checkRunes(true));
  pasteRunesBtn.addEventListener("click",pasteRunes);
  refreshTradeStatus();
};
