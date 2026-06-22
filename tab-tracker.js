/* Tab Tracker — value the currency in a public stash tab, lazy-init on first open.
   Reads the tab via Trade2 (account search + the 10-div sentinel) and prices each
   item at live market value. See server.js fetchTrackedTab. */
window.__viewInit = window.__viewInit || {};
window.__viewInit["tab-tracker"] = function () {
  const acctInput = document.getElementById("ttAccount");
  const leagueInput = document.getElementById("ttLeague");
  const loadBtn = document.getElementById("ttLoad");
  const statusEl = document.getElementById("ttStatus");
  const totalEl = document.getElementById("ttTotal");
  const rows = document.getElementById("ttRows");
  const wrap = document.getElementById("ttTableWrap");

  function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
  function setStatus(t,k){statusEl.textContent=t;statusEl.className="status "+(k||"")}
  function fxEx(v){
    if(typeof v!=="number"||!isFinite(v)) return "";
    if(v>=10) return Math.round(v)+" ex";
    if(v>=1) return v.toFixed(2)+" ex";
    return v.toFixed(3)+" ex";
  }

  function render(data){
    if(data.error){ setStatus(data.error,"err"); return; }
    if(data.limited){ setStatus("Trade2 is rate-limited right now — try again shortly.","err"); return; }
    if(data.note && !(data.results||[]).length){
      wrap.hidden=true; totalEl.hidden=true;
      setStatus(data.note,"");
      return;
    }
    const results=data.results||[];
    totalEl.hidden=false;
    totalEl.innerHTML='<b>'+(data.totalDiv||0)+' div</b> <span>('+fxEx(data.totalEx||0)+') across '+results.length+' items</span>';
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
    setStatus("Valued "+results.length+" items"+(data.updated?" · live market prices":"")+".","ok");
  }

  async function load(){
    const account=acctInput.value.trim();
    const league=leagueInput.value.trim()||"Runes of Aldur";
    if(!account){ setStatus("Enter your PoE account name (e.g. Name#1234).","err"); return; }
    loadBtn.disabled=true;
    setStatus("Reading your public tab and pricing it… (can take ~20s)","");
    try{
      const r=await fetch("/api/tab-tracker?account="+encodeURIComponent(account)+"&league="+encodeURIComponent(league));
      if(!r.ok) throw new Error("server returned HTTP "+r.status);
      render(await r.json());
    }catch(err){
      setStatus("Failed: "+err.message,"err");
    }finally{
      loadBtn.disabled=false;
    }
  }

  loadBtn.addEventListener("click",load);
};
