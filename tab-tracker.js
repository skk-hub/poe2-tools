/* Tab Tracker — value the currency in a public stash tab, lazy-init on first open.
   Reads the tab via Trade2 (account search + the 10-div marker), then fills market
   prices a small batch per poll so it can't trip the shared rate limit. See
   server.js fetchTrackedTab. */
window.__viewInit = window.__viewInit || {};
window.__viewInit["tab-tracker"] = function () {
  const acctInput = document.getElementById("ttAccount");
  const leagueInput = document.getElementById("ttLeague");
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

  async function hit(account,league,refresh){
    const r=await fetch("/api/tab-tracker?account="+encodeURIComponent(account)+"&league="+encodeURIComponent(league)+(refresh?"&refresh=1":""));
    if(!r.ok) throw new Error("server returned HTTP "+r.status);
    return r.json();
  }

  async function load(){
    if(polling) return;
    const account=acctInput.value.trim();
    const league=leagueInput.value.trim()||"Runes of Aldur";
    if(!account){ setStatus("Enter your PoE account name (e.g. Name#1234).","err"); return; }
    loadBtn.disabled=true;
    polling=true;
    setStatus("Reading your tracked tab…","");
    try{
      let data=await hit(account,league,true); // force a fresh read
      if(data.error){ setStatus(data.error,"err"); return; }
      if(data.limited && !(data.results||[]).length){ setStatus("Trade2 is rate-limited right now — try again shortly.","err"); return; }
      if(data.note && !(data.results||[]).length){ wrap.hidden=true; totalEl.hidden=true; setStatus(data.note,""); return; }
      render(data);
      // Fill remaining prices a batch at a time off the CACHED tab (no re-search).
      while((data.remaining||0)>0 && !data.limited){
        setStatus("Pricing "+(data.pricedCount||0)+" of "+data.results.length+" — filling live market values…","");
        await sleep(6000);
        data=await hit(account,league,false);
        render(data);
      }
      if(data.limited && (data.remaining||0)>0){
        setStatus("Priced "+data.pricedCount+" of "+data.results.length+". Trade2 hit its limit — click Value tab again in a bit to finish the rest.","err");
      }else{
        setStatus("Valued all "+data.results.length+" items at live market prices.","ok");
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
