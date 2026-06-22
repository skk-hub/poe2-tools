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

  loadBtn.addEventListener("click",load);
};
