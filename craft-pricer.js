/* Craft Pricer — placeholder pending rebuild (the #craft-pricer view shows a
   "being rebuilt" message). CRAFTS data + render/refreshPrices kept for the redo;
   render()/refreshPrices() no-op while #grid/#league/#refresh don't exist.
   Inlined view, lazy-init on first open. */
window.__viewInit = window.__viewInit || {};
window.__viewInit["craft-pricer"] = function () {
  let P={}; let DV=0;
  const CRAFTS=[
{T:"Crit Bow - ilvl 75",D:"Base: Obliterator Bow or Warmonger Bow with high %phys. Aug the base before step 1.",I:[
  {l:"Greater Essence of Seeking",id:"greater-essence-of-seeking",c:"e",n:"Step 1 - grants T3 Crit"},
  {l:"Sinistral Necromancy",id:"omen-of-sinistral-necromancy",c:"o",n:"Step 2 - unveil a prefix slot"},
  {l:"Jawbone",id:"gnawed-jawbone",c:"b",n:"Step 2 - bone used with Sinistral Necromancy (cheapest tier)"},
  {l:"Ancient Jawbone",id:"ancient-jawbone",c:"b",n:"Step 2 - guide says cheap at league start (currently expensive)",opt:1},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Step 2 - alternative to Sinistral Necro combo depending on prices",opt:1},
  {l:"Omen of Greater Exaltation",id:"omen-of-greater-exaltation",c:"o",n:"Step 3 - pair with exalt to fill last 2 affixes"},
  {l:"Greater Exalted Orb",id:"greater-exalted-orb",c:"b",n:"Step 3 - cheaper exalt option"},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Step 3 - better exalt option",opt:1}
]},
{T:"Quiver - ilvl 75 (Budget / Main)",D:"RNG-heavy. Target: flat dmg or inc bow dmg prefix + +1 / crit / atk spd suffix.",I:[
  {l:"Perfect Orb of Transmutation",id:"perfect-orb-of-transmutation",c:"b",n:"Step 1 - trans the base"},
  {l:"Perfect Orb of Augmentation",id:"perfect-orb-of-augmentation",c:"b",n:"Step 1 - aug after trans"},
  {l:"Perfect Regal Orb",id:"perfect-regal-orb",c:"b",n:"Step 2 - regal for 3rd affix"},
  {l:"Greater Chaos Orb",id:"greater-chaos-orb",c:"b",n:"Step 3 - replace bad affix (2/3 brick risk)",opt:1},
  {l:"Dextral Necromancy",id:"omen-of-dextral-necromancy",c:"o",n:"Step 4 - jawbone the suffix"},
  {l:"Jawbone",id:"gnawed-jawbone",c:"b",n:"Step 4 - bone used with Dextral Necromancy"},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Step 4 - use if you land 3 GG mods",opt:1},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Step 5 - finish craft if good suffix hit",opt:1},
  {l:"Omen of Dextral Exaltation",id:"omen-of-dextral-exaltation",c:"o",n:"Step 5 - double exalt omen (suffix-targeting)",opt:1}
]},
{T:"Quiver - ilvl 75 (Expensive / High Ceiling)",D:"Needs +2 lvls/crit suffix + T1 flat. Fracture + dual omen combo.",I:[
  {l:"Jawbone",id:"gnawed-jawbone",c:"b",n:"Jawbone the suffix before fracturing"},
  {l:"Fracturing Orb",id:"fracturing-orb",c:"b",n:"1/3 to fracture flat dmg - miss = fall back to budget method"},
  {l:"Exalted Orb",id:"exalted",c:"b",n:"Exalt 1 prefix mod after fracture"},
  {l:"Essence of Hysteria",id:"essence-of-hysteria",c:"e",n:"Paired with Sinistral Crystallisation - 100% chance for bow dmg prefix"},
  {l:"Omen of Sinistral Crystallisation",id:"omen-of-sinistral-crystallisation",c:"o",n:"Paired with Essence of Hysteria"},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Slam last prefix - pray for no accuracy roll"},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Last suffix cycling - target crit or atk spd",opt:1},
  {l:"Omen of Light",id:"omen-of-light",c:"o",n:"Last suffix cycling - target crit or atk spd",opt:1},
  {l:"Omen of Whittling",id:"omen-of-whittling",c:"o",n:"Last suffix cycling - alternative omen",opt:1}
]},
{T:"Amulet - ilvl 80 / 82",D:"Mostly deterministic but expensive. ilvl 82 = T1 resists. Needs 1 fractured +3 proj base.",I:[
  {l:"Fracturing Orb",id:"fracturing-orb",c:"b",n:"Step 1 - fracture +3 proj (or buy pre-fractured base)"},
  {l:"Chaos Orb (spam)",id:"chaos",c:"b",n:"Step 3 - spam until T1 or T2 spirit (variable qty - budget 10-30+)"},
  {l:"Omen of Dextral Exaltation",id:"omen-of-dextral-exaltation",c:"o",n:"Steps 4 & 7 - suffix-targeting exalt"},
  {l:"Exalted Orb",id:"exalted",c:"b",n:"Step 4 - add 1 suffix (used with Dextral Exaltation)"},
  {l:"Omen of Dextral Crystallisation",id:"omen-of-dextral-crystallisation",c:"o",n:"Step 5 - paired with Essence of Enhancement"},
  {l:"Essence of Enhancement",id:"essence-of-enhancement",c:"e",n:"Step 5 - paired with Dextral Crystallisation"},
  {l:"Tul's Catalyst (Ice Resist)",id:"tuls-catalyst",c:"k",n:"Step 6 - quality to 20% (pick your resist type)",opt:1},
  {l:"Xoph's Catalyst (Fire Resist)",id:"xophs-catalyst",c:"k",n:"Step 6 - fire resist quality alt",opt:1},
  {l:"Esh's Catalyst (Lightning Resist)",id:"eshs-catalyst",c:"k",n:"Step 6 - lightning resist quality alt",opt:1},
  {l:"Collarbone",id:"gnawed-collarbone",c:"b",n:"Step 9 - remove a bad mod (cheapest tier shown)",opt:1},
  {l:"Dextral Necromancy",id:"omen-of-dextral-necromancy",c:"o",n:"Step 9 - used with Collarbone",opt:1},
  {l:"Omen of Light",id:"omen-of-light",c:"o",n:"Step 9 - target specific prefix to remove",opt:1}
]},
{T:"Helmet - ilvl 78 (Safe / Cheap)",D:"Consistent method. Start with T1 +energy shield base.",I:[
  {l:"Greater Essence of Enhancement",id:"greater-essence-of-enhancement",c:"e",n:"Step 2 - deterministic mod"},
  {l:"Sinistral Necromancy",id:"omen-of-sinistral-necromancy",c:"o",n:"Step 3 - unveil a prefix"},
  {l:"Preserved Rib",id:"preserved-rib",c:"b",n:"Step 3 - bone used with Sinistral Necromancy"},
  {l:"Greater Exalted Orb",id:"greater-exalted-orb",c:"b",n:"Step 5 - finish suffixes (hybrid %ES not T1)"},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Step 5 - use instead if hybrid was T1",opt:1},
  {l:"Omen of Greater Exaltation",id:"omen-of-greater-exaltation",c:"o",n:"Step 5 - upgrade exalt tier",opt:1},
  {l:"Vaal Armourer's Infuser",id:"vaal-armourers-infuser",c:"b",n:"Step 6 - corrupt without bricking (add socket first)",opt:1}
]},
{T:"Helmet - ilvl 78 (RNG / Triple T1 Gamble)",D:"Same cost floor, higher ceiling. Can land triple T1 prefix.",I:[
  {l:"Perfect Orb of Transmutation",id:"perfect-orb-of-transmutation",c:"b",n:"Step 1 - trans/aug base until T1 %ES or +ES"},
  {l:"Perfect Orb of Augmentation",id:"perfect-orb-of-augmentation",c:"b",n:"Step 1 - aug after trans"},
  {l:"Greater Essence of Enhancement",id:"greater-essence-of-enhancement",c:"e",n:"Step 2 - use if prefix+suffix are good (resist/rarity variant)",opt:1},
  {l:"Sinistral Necromancy",id:"omen-of-sinistral-necromancy",c:"o",n:"Step 3 - unveil a prefix"},
  {l:"Preserved Rib",id:"preserved-rib",c:"b",n:"Step 3 - bone used with Sinistral Necromancy"},
  {l:"Greater Exalted Orb",id:"greater-exalted-orb",c:"b",n:"Step 3 - slam a suffix"},
  {l:"Omen of Greater Exaltation",id:"omen-of-greater-exaltation",c:"o",n:"Step 3 - pair with Greater Exalt"},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Step 4 - try to replace a bad affix",opt:1},
  {l:"Vaal Armourer's Infuser",id:"vaal-armourers-infuser",c:"b",n:"Step 5 - corrupt if prefixes are high tier",opt:1}
]}
];
  const BC={e:"be",o:"bo",b:"bc",k:"bk"};
const BL={e:"essence",o:"omen",b:"currency",k:"catalyst"};
  const grid=document.getElementById("cpGrid");
  const statusEl=document.getElementById("cpStatus");
  const refreshBtn=document.getElementById("cpRefresh");
  const leagueInput=document.getElementById("cpLeague");
  const homeCraftCount=document.getElementById("homeCraftCount");
  const homePriceStatus=document.getElementById("homePriceStatus");
  function fc(v){return v>=10?Math.round(v)+"c":v.toFixed(1)+"c"}
  function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
  function setStatus(text,kind){if(!statusEl)return;statusEl.textContent=text;statusEl.className="status "+(kind||"")}
  function render(){
  if(!grid) return;
  grid.innerHTML="";
  for(const craft of CRAFTS){
    let tot=0,all=0;
    let rows="";
    for(const item of craft.I){
      const f=P[item.id];
      let price;
      if(f){
        price='<div class="pc">'+fc(f.c)+'</div>';
        if(DV>0) price+='<div class="pd">'+(f.c/DV).toFixed(2)+'d</div>';
        if(!item.opt) tot+=f.c;
        all+=f.c;
      }else{
        price='<div class="pm">'+(DV?"not found":"refresh needed")+'</div>';
      }
      rows+='<div class="row'+(item.opt?" opt":"")+'"><div class="il"><div class="in"><span class="lbl">'+esc(item.l)+'</span><span class="bdg '+BC[item.c]+'">'+BL[item.c]+'</span>'+(item.opt?'<span class="ot">optional</span>':'')+'</div><div class="nt">'+esc(item.n)+'</div></div><div class="ip">'+price+'</div></div>';
    }
    const dv=DV>0?'<span class="fd">/ '+(tot/DV).toFixed(2)+'d</span>':"";
    const allDv=DV>0?'<span class="fd">/ '+(all/DV).toFixed(2)+'d</span>':"";
    const hasOpt=craft.I.some(i=>i.opt);
    const optLine=hasOpt?'<div class="cf" style="border-top:none;padding-top:0;opacity:.65"><span class="fl">With all optionals</span><span><span class="ft">'+(DV?Math.round(all)+"c":"--")+'</span>'+allDv+'</span></div>':"";
    const card=document.createElement("div");
    card.className="card";
    card.innerHTML='<div class="ch"><div class="ct">'+esc(craft.T)+'</div><div class="cd">'+esc(craft.D)+'</div></div><div>'+rows+'</div><div class="cf"><span class="fl">Required floor</span><span><span class="ft">'+(DV?Math.round(tot)+"c":"--")+'</span>'+dv+'</span></div>'+optLine;
    grid.appendChild(card);
  }
}
  async function refreshPrices(){
  if(!grid||!leagueInput||!refreshBtn) return;
  const league=leagueInput.value.trim()||"Runes of Aldur";
  if(location.protocol==="file:"){
    setStatus("Live refresh needs Start PoE2 Craft Pricer.cmd so the page can use localhost.", "err");
    return;
  }
  refreshBtn.disabled=true;
  setStatus("Fetching prices...", "");
  try{
    const r=await fetch("/api/prices?league="+encodeURIComponent(league));
    if(!r.ok) throw new Error("local server returned HTTP "+r.status);
    const data=await r.json();
    if(!data.count) throw new Error("No price data loaded. Check the league name.");
    P=data.prices;
    DV=data.divineRate;
    render();
    const stamp=new Date().toLocaleString();
    setStatus("Updated "+stamp+" - 1 divine = "+Math.round(DV)+"c", "ok");
    if(homePriceStatus) homePriceStatus.textContent=Math.round(DV)+"c divine";
  }catch(err){
    setStatus("Refresh failed: "+err.message+". Open the snapshot link if your browser blocks direct API calls.", "err");
  }finally{
    refreshBtn.disabled=false;
  }
}
  if(refreshBtn) refreshBtn.addEventListener("click",refreshPrices);
  if(homeCraftCount) homeCraftCount.textContent=String(CRAFTS.length);
  render();
  refreshPrices();
};
