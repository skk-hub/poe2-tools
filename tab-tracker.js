/* Tab Tracker — value the currency in a public stash tab, lazy-init on first open.
   Reads the tab via Trade2 (account search + the 10-div marker), then fills market
   prices a small batch per poll so it can't trip the shared rate limit. See
   server.js fetchTrackedTab. */
window.__viewInit = window.__viewInit || {};
window.__viewInit["tab-tracker"] = function () {
  const acctInput = document.getElementById("ttAccount");
  const leagueInput = document.getElementById("ttLeague");
  const markersInput = document.getElementById("ttMarkers");
  const loadBtn = document.getElementById("ttLoad");
  const statusEl = document.getElementById("ttStatus");
  const totalEl = document.getElementById("ttTotal");
  const rows = document.getElementById("ttRows");
  const wrap = document.getElementById("ttTableWrap");
  const copySnippetBtn = document.getElementById("ttCopySnippet");
  const pasteBox = document.getElementById("ttPaste");
  const valuePasteBtn = document.getElementById("ttValuePaste");
  const progWrap = document.getElementById("ttProgress");
  const progFill = document.getElementById("ttProgressFill");
  const progLabel = document.getElementById("ttProgressLabel");
  let polling = false, cancelRead = false;

  function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
  function setStatus(t,k){statusEl.textContent=t;statusEl.className="status "+(k||"")}
  // Visible progress bar — the obvious "it's working" signal through the whole grind.
  // frac 0..1 fills the bar; pass null to keep the current width (e.g. while waiting on
  // a cooldown). state: "active" (pulsing), "wait" (striped cooldown), "done" (green).
  function setProgress(label,frac,state){
    if(!progWrap) return;
    progWrap.hidden=false;
    if(frac!=null) progFill.style.width=Math.max(3,Math.round(frac*100))+"%";
    progFill.className="tt-progress-fill "+(state||"active");
    progLabel.textContent=label;
  }
  function hideProgress(){ if(progWrap) progWrap.hidden=true; }
  function fxEx(v){
    if(typeof v!=="number"||!isFinite(v)) return "";
    if(v>=10) return Math.round(v)+" ex";
    if(v>=1) return v.toFixed(2)+" ex";
    return v.toFixed(3)+" ex";
  }
  function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

  function render(data){
    const results=data.results||[];
    totalEl.hidden=false;
    const thinNote=(data.thinCount||0)>0?' · '+data.thinCount+' no buyers':'';
    totalEl.innerHTML='<b>'+(data.totalDiv||0)+' div</b> <span>('+fxEx(data.totalEx||0)+' sellable) · '+(data.pricedCount||0)+'/'+results.length+' priced'+thinNote+'</span>';
    rows.innerHTML=results.map(item=>{
      let eachCell, valCell;
      if(item.total){ eachCell=fxEx(item.each); valCell=fxEx(item.total); }
      else if(item.thin){ eachCell='<span class="muted">—</span>'; valCell='<span class="muted">—</span>'; }
      else { eachCell='<span class="muted">pricing…</span>'; valCell=''; }
      return '<tr'+(item.total?'':' class="muted"')+'>'+
        '<td class="num">'+esc(item.qty)+'</td>'+
        '<td>'+esc(item.name)+'</td>'+
        '<td class="num">'+eachCell+'</td>'+
        '<td class="num">'+valCell+'</td>'+
        '<td>'+esc(item.source||"")+'</td>'+
      '</tr>';
    }).join("");
    wrap.hidden=false;
  }

  async function hit(account,league,markers,refresh){
    const r=await fetch("/api/tab-tracker?account="+encodeURIComponent(account)+"&league="+encodeURIComponent(league)+"&markers="+encodeURIComponent(markers)+(refresh?"&refresh=1":""));
    if(!r.ok) throw new Error("server returned HTTP "+r.status);
    return r.json();
  }

  // Poll the (free, local) trade-status until the cooldown clears, counting down so a
  // big read can auto-resume hands-off across rate-limit windows. Returns false if the
  // user cancelled (clicked Stop) or it waited absurdly long.
  const MAX_AUTO_WAIT = 240;   // auto-wait short bans; a longer one (the 30-min ban) → stop, resume later
  async function waitForCooldown(label){
    for(let cycles=0; cycles<15 && !cancelRead; cycles++){
      let st; try{ st=await (await fetch("/api/trade-status")).json(); }catch{ return true; }
      if(!st.limited) return true;
      let secs=Math.max(1, st.secondsRemaining||30);
      if(secs > MAX_AUTO_WAIT) return false;   // long ban → bail out; cached progress resumes on next click
      while(secs>0){
        if(cancelRead) return false;
        const msg=label+" — rate-limited, auto-resuming in "+secs+"s… (Stop to halt)";
        setStatus(msg,""); setProgress(msg,null,"wait");
        await sleep(1000); secs--;
      }
    }
    return !cancelRead;
  }

  async function load(){
    if(polling){ cancelRead=true; setStatus("Stopping after this step…",""); return; }  // button doubles as Stop
    const account=acctInput.value.trim();
    const league=leagueInput.value.trim()||"Runes of Aldur";
    const markers=markersInput.value.trim()||"11,12,13,14";
    if(!account){ setStatus("Enter your PoE account name (e.g. Name#1234).","err"); return; }
    saveInputs();
    const totalBands=markers.split(/[, ]+/).filter(Boolean).length;
    cancelRead=false; polling=true; loadBtn.textContent="Stop";
    setStatus("Reading your tracked tab…","");
    setProgress("Reading your tracked tab…",0.02,"active");
    try{
      // READ/RESUME, hands-off: each pass reads price bands until it trips; finished
      // bands are cached. On a trip we wait out the cooldown (countdown) and continue
      // automatically until every band is read — one click, walk away.
      let data=await hit(account,league,markers,true);
      if(data.error){ setStatus(data.error,"err"); hideProgress(); return; }
      if((data.results||[]).length) render(data);
      while((data.unreadBands||0)>0 && !cancelRead){
        if(data.limited){
          const cont=await waitForCooldown("Read "+(totalBands-(data.unreadBands||0))+"/"+totalBands+" bands");
          if(!cont) break;
        }
        const readDone=totalBands-(data.unreadBands||0);
        setStatus("Reading price bands… "+readDone+" of "+totalBands+" done","");
        setProgress("Reading price bands — "+readDone+" of "+totalBands,(readDone/totalBands)*0.4,"active");
        data=await hit(account,league,markers,true);
        if(data.error){ setStatus(data.error,"err"); hideProgress(); return; }
        if((data.results||[]).length) render(data);
      }
      if(!(data.results||[]).length){
        if(data.note){ wrap.hidden=true; totalEl.hidden=true; setStatus(data.note,""); hideProgress(); return; }
        if(data.limited){ setStatus("Trade2 is rate-limited — click Value tab again in a bit.","err"); hideProgress(); return; }
      }
      // PRICE FILL: poll the cached path (no re-search) to fill values in batches.
      // AUTO-RESUMES across rate-limit cooldowns, hands-off, just like the read — a big
      // tab can't price in one window, so we wait out each cooldown and continue until
      // every item is priced or marked no-buyers. One click, walk away. (Value tab
      // doubles as Stop the whole time.)
      while((data.remaining||0)>0 && !cancelRead){
        if(data.limited){
          if(!await waitForCooldown("Pricing "+(data.pricedCount||0)+"/"+data.results.length)) break;
        }else{
          const tot=data.results.length||1, done=(data.pricedCount||0)+(data.thinCount||0);
          setStatus("Pricing "+(data.pricedCount||0)+" of "+data.results.length+" — filling live market values…","");
          setProgress("Pricing "+done+" of "+tot+" items…",0.4+(done/tot)*0.6,"active");
          await sleep(6000);
        }
        data=await hit(account,league,markers,false);
        render(data);
      }
      const warns=[];
      if(data.truncated) warns.push("⚠ One marker price has 100+ items — add more marker prices so none exceeds 100 (e.g. widen the list).");
      if((data.unreadBands||0)>0) warns.push("⚠ "+data.unreadBands+" band(s) still unread — click Value tab to resume.");
      const w=warns.length?" "+warns.join(" "):"";
      if(cancelRead){
        setStatus("Stopped. Priced "+data.pricedCount+" of "+data.results.length+" so far — click Value tab to continue."+w,"err");
        setProgress("Stopped — "+data.pricedCount+" of "+data.results.length+" priced. Click Value tab to continue.",null,"");
      }else if((data.remaining||0)>0){
        setStatus("Hit a long rate-limit ban — priced "+data.pricedCount+" of "+data.results.length+" so far (saved). Click Value tab again in a few minutes to continue where it left off."+w,"err");
        setProgress("Rate-limit ban — "+data.pricedCount+" of "+data.results.length+" priced (saved). Click Value tab in a few min to continue.",null,"");
      }else{
        const thinTail=(data.thinCount||0)>0?" "+data.thinCount+" had no live buyers (thin)."  :"";
        setStatus("Valued "+data.pricedCount+" of "+data.results.length+" items at live market prices."+thinTail+w,"ok");
        setProgress("Done — valued "+data.pricedCount+" of "+data.results.length+" items."+thinTail,1,"done");
      }
    }catch(err){
      setStatus("Value failed: "+err.message,"err"); hideProgress();
    }finally{
      polling=false; cancelRead=false; loadBtn.textContent="Value tab"; loadBtn.disabled=false;
    }
  }

  // ── Browser-side read (run on pathofexile.com via VPN) ──────────────────────
  async function copyText(txt){
    if(navigator.clipboard && window.isSecureContext){ try{ await navigator.clipboard.writeText(txt); return true; }catch(e){} }
    const ta=document.createElement("textarea"); ta.value=txt; ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok=false; try{ ok=document.execCommand("copy"); }catch(e){} ta.remove(); return ok;
  }
  // Builds a console snippet that reads the tracked items on pathofexile.com (same
  // origin → no CORS; runs through whatever IP the browser uses, i.e. your VPN) and
  // copies them as "Name xQty" lines. Self-paces off GGG's own rate-limit headers.
  function readerSnippet(account,league,markers){
    return "(async()=>{\n"
      +"const ACCOUNT="+JSON.stringify(account)+",LEAGUE="+JSON.stringify(league)+",MARKERS="+JSON.stringify(markers)+";\n"
      +"const base=\"/api/trade2\",sleep=ms=>new Promise(r=>setTimeout(r,ms));\n"
      +"async function call(u,o){for(let t=0;t<8;t++){const r=await fetch(u,Object.assign({headers:{\"Content-Type\":\"application/json\"},credentials:\"include\"},o));\n"
      +"if(r.status===429){const ra=Number(r.headers.get(\"retry-after\"))||60;console.log(\"rate-limited, waiting \"+ra+\"s…\");await sleep(ra*1000);continue;}\n"
      +"const st=r.headers.get(\"x-rate-limit-ip-state\"),lim=r.headers.get(\"x-rate-limit-ip\");let w=1300;\n"
      +"if(st&&lim){const ss=st.split(\",\"),ll=lim.split(\",\");for(let i=0;i<Math.min(ss.length,ll.length);i++){const a=ss[i].split(\":\").map(Number),b=ll[i].split(\":\").map(Number);if(b[0]&&a[0]>=b[0]-1)w=Math.max(w,(a[1]/b[0])*1300);}}\n"
      +"await sleep(w);return r;}throw new Error(\"kept hitting the rate limit — wait a few minutes and re-run\");}\n"
      +"const lines=[];for(const m of MARKERS){const body=JSON.stringify({query:{status:{option:\"any\"},filters:{trade_filters:{filters:{account:{input:ACCOUNT},price:{option:\"divine\",min:m,max:m}}}}},sort:{price:\"desc\"}});\n"
      +"const s=await(await call(base+\"/search/poe2/\"+encodeURIComponent(LEAGUE),{method:\"POST\",body})).json();const ids=s.result||[];\n"
      +"console.log(m+\" div: \"+ids.length+\" items\"+((s.total||0)>ids.length?\" (100+ — split this price!)\":\"\"));\n"
      +"for(let i=0;i<ids.length;i+=10){const f=await(await call(base+\"/fetch/\"+ids.slice(i,i+10).join(\",\")+\"?query=\"+encodeURIComponent(s.id))).json();\n"
      +"for(const r of f.result||[]){const it=r.item||{},n=it.typeLine||it.baseType||it.name;if(n)lines.push(n+\" x\"+(it.stackSize||1));}console.log(\"  \"+Math.min(i+10,ids.length)+\"/\"+ids.length);}}\n"
      +"const out=lines.join(\"\\n\");try{await navigator.clipboard.writeText(out);console.log(\"\\n✅ COPIED \"+lines.length+\" items — paste into the Tab Tracker.\");}catch(e){console.log(\"\\n✅ \"+lines.length+\" items (copy below):\\n\"+out);}\n"
      +"})();";
  }
  async function copySnippet(){
    const account=acctInput.value.trim();
    const league=leagueInput.value.trim()||"Runes of Aldur";
    const markers=(markersInput.value.trim()||"11,12,13,14").split(/[, ]+/).map(Number).filter(n=>n>0);
    if(!account){ setStatus("Enter your account name first (so the snippet knows what to read).","err"); return; }
    const ok=await copyText(readerSnippet(account,league,markers));
    setStatus(ok?"Snippet copied. On pathofexile.com (VPN on), press F12 → Console, paste, Enter. Then paste the items below.":"Copy failed — select the console manually.", ok?"ok":"err");
  }
  async function valuePasted(){
    if(polling) return;
    const account=acctInput.value.trim()||"(pasted)";
    const league=leagueInput.value.trim()||"Runes of Aldur";
    const items=pasteBox.value.trim();
    if(!items){ setStatus("Paste the items the snippet copied first.","err"); return; }
    valuePasteBtn.disabled=true; polling=true; cancelRead=false;
    setStatus("Valuing pasted items…","");
    setProgress("Valuing pasted items…",0.05,"active");
    try{
      const r=await fetch("/api/tab-tracker",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account,league,items})});
      if(!r.ok) throw new Error("server returned HTTP "+r.status);
      let data=await r.json();
      if(data.note && !(data.results||[]).length){ setStatus(data.note,"err"); hideProgress(); return; }
      render(data);
      // fill prices in batches off the cached pasted set (no re-read); auto-resume
      // across rate-limit cooldowns so a big paste finishes hands-off.
      while((data.remaining||0)>0 && !cancelRead){
        if(data.limited){
          if(!await waitForCooldown("Pricing "+(data.pricedCount||0)+"/"+data.results.length)) break;
        }else{
          const tot=data.results.length||1, done=(data.pricedCount||0)+(data.thinCount||0);
          setStatus("Pricing "+(data.pricedCount||0)+" of "+data.results.length+" — filling live market values…","");
          setProgress("Pricing "+done+" of "+tot+" items…",done/tot,"active");
          await sleep(6000);
        }
        const p=await fetch("/api/tab-tracker?account="+encodeURIComponent(account)+"&league="+encodeURIComponent(league)+"&paste=1");
        data=await p.json(); render(data);
      }
      const thinTail=(data.thinCount||0)>0?" "+data.thinCount+" had no live buyers (thin).":"";
      if(cancelRead){
        setStatus("Stopped. Priced "+data.pricedCount+" of "+data.results.length+" — click Value pasted items to continue.","err");
        setProgress("Stopped — "+data.pricedCount+" of "+data.results.length+" priced.",null,"");
      }else if((data.remaining||0)>0){
        setStatus("Priced "+data.pricedCount+" of "+data.results.length+" — long cooldown, click Value pasted items to finish.","err");
        setProgress("Paused — "+data.pricedCount+" of "+data.results.length+". Click Value pasted items to finish.",null,"");
      }else{
        setStatus("Valued "+data.pricedCount+" of "+data.results.length+" items at live market prices."+thinTail,"ok");
        setProgress("Done — valued "+data.pricedCount+" of "+data.results.length+" items."+thinTail,1,"done");
      }
    }catch(err){ setStatus("Value failed: "+err.message,"err"); hideProgress(); }
    finally{ valuePasteBtn.disabled=false; polling=false; cancelRead=false; }
  }

  // Remember account/league/markers so reopening can show the last scan without retyping.
  const LS_KEY="tt:last";
  function saveInputs(){ try{ localStorage.setItem(LS_KEY, JSON.stringify({account:acctInput.value,league:leagueInput.value,markers:markersInput.value})); }catch{} }
  function restoreInputs(){ try{ const s=JSON.parse(localStorage.getItem(LS_KEY)||"{}"); if(s.account&&!acctInput.value)acctInput.value=s.account; if(s.league)leagueInput.value=s.league; if(s.markers)markersInput.value=s.markers; }catch{} }
  // On open, render the last scan straight from cache (refresh=false → ZERO Trade2 reads),
  // so you don't rescan every time. Click Value tab when you actually want fresh values.
  async function showCached(){
    const account=acctInput.value.trim(); if(!account) return;
    const league=leagueInput.value.trim()||"Runes of Aldur";
    const markers=markersInput.value.trim()||"11,12,13,14";
    try{
      const data=await hit(account,league,markers,false);
      if((data.results||[]).length){
        render(data);
        const when=data.scannedAt?new Date(data.scannedAt).toLocaleString():"";
        setStatus("Showing your last scan"+(when?" from "+when:"")+". Click Value tab to refresh.","");
      }
    }catch{}
  }

  loadBtn.addEventListener("click",load);
  copySnippetBtn.addEventListener("click",copySnippet);
  valuePasteBtn.addEventListener("click",valuePasted);
  [acctInput,leagueInput,markersInput].forEach(el=>el.addEventListener("change",saveInputs));
  restoreInputs();
  showCached();
};
