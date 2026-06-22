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
  let polling = false;

  function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
  function setStatus(t,k){statusEl.textContent=t;statusEl.className="status "+(k||"")}
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
    totalEl.innerHTML='<b>'+(data.totalDiv||0)+' div</b> <span>('+fxEx(data.totalEx||0)+') · '+(data.pricedCount||0)+'/'+results.length+' priced</span>';
    rows.innerHTML=results.map(item=>{
      const missing=!item.total;
      return '<tr>'+
        '<td class="num">'+esc(item.qty)+'</td>'+
        '<td>'+esc(item.name)+'</td>'+
        '<td class="num">'+(missing?'<span class="muted">pricing…</span>':fxEx(item.each))+'</td>'+
        '<td class="num">'+(missing?"":fxEx(item.total))+'</td>'+
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

  async function load(){
    if(polling) return;
    const account=acctInput.value.trim();
    const league=leagueInput.value.trim()||"Runes of Aldur";
    const markers=markersInput.value.trim()||"11,12,13,14";
    if(!account){ setStatus("Enter your PoE account name (e.g. Name#1234).","err"); return; }
    const totalBands=markers.split(/[, ]+/).filter(Boolean).length;
    loadBtn.disabled=true;
    polling=true;
    setStatus("Reading your tracked tab…","");
    try{
      // READ/RESUME: each refresh pass reads price bands until it trips; finished
      // bands are cached, so passes continue where the last left off (no restart).
      let data=await hit(account,league,markers,true);
      if(data.error){ setStatus(data.error,"err"); return; }
      while((data.unreadBands||0)>0 && !data.limited){
        if((data.results||[]).length) render(data);
        setStatus("Reading price bands… "+(totalBands-(data.unreadBands||0))+" of "+totalBands+" done","");
        data=await hit(account,league,markers,true);
        if(data.error){ setStatus(data.error,"err"); return; }
      }
      if((data.results||[]).length) render(data);
      else if(data.note){ wrap.hidden=true; totalEl.hidden=true; setStatus(data.note,""); return; }
      else if(data.limited){ setStatus("Trade2 is rate-limited right now — click Value tab again in a bit.","err"); return; }
      // PRICE FILL: poll the cached path (no re-search) to fill values in batches.
      while((data.remaining||0)>0 && !data.limited){
        setStatus("Pricing "+(data.pricedCount||0)+" of "+data.results.length+" — filling live market values…","");
        await sleep(6000);
        data=await hit(account,league,markers,false);
        render(data);
      }
      const warns=[];
      if(data.truncated) warns.push("⚠ One marker price has 100+ items — add more marker prices so none exceeds 100 (e.g. widen the list).");
      if((data.unreadBands||0)>0) warns.push("⚠ "+data.unreadBands+" price band(s) still unread — click Value tab again to resume (it continues, doesn't restart).");
      const w=warns.length?" "+warns.join(" "):"";
      if(data.limited && ((data.remaining||0)>0 || (data.unreadBands||0)>0)){
        setStatus("Priced "+data.pricedCount+" of "+data.results.length+" read so far. Trade2 limit hit — click Value tab again to continue."+w,"err");
      }else{
        setStatus("Valued all "+data.results.length+" items at live market prices."+w,"ok");
      }
    }catch(err){
      setStatus("Failed: "+err.message,"err");
    }finally{
      loadBtn.disabled=false;
      polling=false;
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
    valuePasteBtn.disabled=true; polling=true;
    setStatus("Valuing pasted items…","");
    try{
      const r=await fetch("/api/tab-tracker",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account,league,items})});
      if(!r.ok) throw new Error("server returned HTTP "+r.status);
      let data=await r.json();
      if(data.note && !(data.results||[]).length){ setStatus(data.note,"err"); return; }
      render(data);
      // fill prices in batches off the cached pasted set (no re-read)
      while((data.remaining||0)>0 && !data.limited){
        setStatus("Pricing "+(data.pricedCount||0)+" of "+data.results.length+" — filling live market values…","");
        await sleep(6000);
        const p=await fetch("/api/tab-tracker?account="+encodeURIComponent(account)+"&league="+encodeURIComponent(league)+"&paste=1");
        data=await p.json(); render(data);
      }
      setStatus((data.limited&&(data.remaining||0)>0
        ? "Priced "+data.pricedCount+" of "+data.results.length+". Trade2 busy — click Value pasted items again to finish."
        : "Valued all "+data.results.length+" items at live market prices."),data.limited&&data.remaining>0?"err":"ok");
    }catch(err){ setStatus("Failed: "+err.message,"err"); }
    finally{ valuePasteBtn.disabled=false; polling=false; }
  }

  loadBtn.addEventListener("click",load);
  copySnippetBtn.addEventListener("click",copySnippet);
  valuePasteBtn.addEventListener("click",valuePasted);
};
