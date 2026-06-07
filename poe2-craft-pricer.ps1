#Requires -Version 7
param([string]$League = "Runes of Aldur")

$ErrorActionPreference = "Stop"
$outPath = "$env:USERPROFILE\Desktop\poe2-craft-pricer.html"

Write-Host ""
Write-Host "  PoE2 Craft Pricer" -ForegroundColor Cyan
Write-Host "  League: $League" -ForegroundColor Gray
Write-Host ""

# ── FETCH ────────────────────────────────────────────────────────────────────
# Endpoint: /poe2/api/economy/exchange/current/overview?league=DISPLAY_NAME&type=TYPE
$headers   = @{ "User-Agent" = "poe2-craft-pricer/2.0" }
$leagueEnc = [uri]::EscapeDataString($League)
$base      = "https://poe.ninja/poe2/api/economy/exchange/current/overview?league=$leagueEnc&type="

$priceDict = [ordered]@{}  # id -> { name, chaos }
$chaosRate = 0             # chaos per 1 divine

$types = @("Currency","Essences","Ritual","Abyss","Breach")
foreach ($t in $types) {
    Write-Host "  Fetching $t ..." -ForegroundColor DarkGray
    try {
        $r = Invoke-RestMethod -Uri "$base$t" -Headers $headers -ErrorAction Stop
        $rate = if ($r.core.rates.chaos) { [double]$r.core.rates.chaos } else { 0 }
        if ($rate -gt 0 -and $chaosRate -eq 0) { $chaosRate = $rate }

        # Build name lookup from items array
        $nameMap = @{}
        foreach ($item in $r.items) { $nameMap[$item.id] = $item.name }

        foreach ($line in $r.lines) {
            $chaos = [Math]::Round($line.primaryValue * $rate, 2)
            $priceDict[$line.id] = @{
                name  = if ($nameMap[$line.id]) { $nameMap[$line.id] } else { $line.id }
                chaos = $chaos
            }
        }
    } catch {
        Write-Warning "  Skipped $t`: $($_.Exception.Message)"
    }
}

if ($priceDict.Count -eq 0) {
    Write-Host ""
    Write-Host "  No data loaded — check the league name." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Loaded $($priceDict.Count) items." -ForegroundColor Green
Write-Host "  1 divine = $([Math]::Round($chaosRate))c" -ForegroundColor Green

# ── BUILD ITEMS JSON ─────────────────────────────────────────────────────────
$jsonParts = $priceDict.GetEnumerator() | ForEach-Object {
    $n = $_.Value.name.Replace('\','\\').Replace('"','\"')
    '{"id":"' + $_.Key + '","n":"' + $n + '","c":' + $_.Value.chaos + '}'
}
$itemsJson  = "[" + ($jsonParts -join ",") + "]"
$timestamp  = Get-Date -Format "yyyy-MM-dd HH:mm"
$divineRate = $chaosRate

# ── HTML TEMPLATE ─────────────────────────────────────────────────────────────
# Placeholders: {{LEAGUE}} {{TS}} {{DIVINE}} {{ITEMS}} {{DIVVAL}}
$html = @'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>PoE2 Craft Pricer — {{LEAGUE}}</title>
<style>
:root{--bg:#0d0d0d;--s1:#161616;--s2:#1e1e1e;--bd:#2e2e2e;--gd:#c89b3c;--tx:#d4c4a8;--mu:#666;--gr:#7ec87e;--rd:#cc6a6a;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--tx);font-family:'Segoe UI',sans-serif;font-size:13px;padding:24px 20px;}
h1{color:var(--gd);font-size:20px;}
.sub{color:var(--mu);font-size:11px;margin:5px 0 22px;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px;}
.card{background:var(--s1);border:1px solid var(--bd);border-radius:6px;overflow:hidden;}
.ch{background:var(--s2);border-bottom:1px solid var(--bd);padding:10px 14px;}
.ct{color:var(--gd);font-size:14px;font-weight:bold;}
.cd{color:var(--mu);font-size:11px;margin-top:3px;line-height:1.4;}
.row{display:flex;align-items:flex-start;padding:7px 14px;border-bottom:1px solid #1c1c1c;gap:8px;}
.row:last-child{border-bottom:none;}
.row.opt{opacity:.5;}
.il{flex:1;min-width:0;}
.in{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.lbl{color:var(--tx);}
.opt .lbl{color:var(--mu);}
.bdg{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;}
.bc{background:#2a2218;color:#c89b3c;}
.be{background:#1a2228;color:#6aadcc;}
.bo{background:#22182a;color:#a07ec8;}
.bk{background:#182228;color:#7ec8c8;}
.bb{background:#1a2a1a;color:#7ec87e;}
.ot{font-size:10px;color:var(--mu);font-style:italic;}
.nt{color:#555;font-size:10px;margin-top:2px;line-height:1.3;}
.ip{text-align:right;white-space:nowrap;min-width:90px;}
.pc{color:var(--gd);font-size:13px;font-weight:600;}
.pd{color:var(--gr);font-size:10px;margin-top:1px;}
.pm{color:#553333;font-size:10px;font-style:italic;}
.cf{background:var(--s2);border-top:1px solid var(--bd);padding:8px 14px;display:flex;justify-content:space-between;align-items:center;}
.fl{color:var(--mu);font-size:11px;}
.ft{color:var(--gd);font-weight:bold;font-size:14px;}
.fd{color:var(--gr);font-size:11px;margin-left:8px;}
</style>
</head>
<body>
<h1>PoE2 Craft Pricer — {{LEAGUE}}</h1>
<p class="sub">Updated: {{TS}} &nbsp;·&nbsp; poe.ninja &nbsp;·&nbsp; 1 divine = {{DIVINE}}c &nbsp;·&nbsp; Re-run poe2-craft-pricer.ps1 to refresh</p>
<div class="grid" id="g"></div>
<script>
// id->chaos lookup
const P={};
for(const x of JSON.parse('{{ITEMS}}')) P[x.id]={n:x.n,c:x.c};
const DV={{DIVVAL}};

// c = badge class: b=currency/bone o=omen e=essence k=catalyst
// id = poe.ninja item id
// opt = optional (dim + exclude from total)
const CRAFTS=[
{T:"Crit Bow — ilvl 75",D:"Base: Obliterator Bow or Warmonger Bow with high %phys. Aug the base before step 1.",I:[
  {l:"Greater Essence of Seeking",id:"greater-essence-of-seeking",c:"e",n:"Step 1 — grants T3 Crit"},
  {l:"Sinistral Necromancy",id:"omen-of-sinistral-necromancy",c:"o",n:"Step 2 — unveil a prefix slot"},
  {l:"Jawbone",id:"gnawed-jawbone",c:"b",n:"Step 2 — bone used with Sinistral Necromancy (cheapest tier)"},
  {l:"Ancient Jawbone",id:"ancient-jawbone",c:"b",n:"Step 2 — guide says cheap at league start (currently expensive)",opt:1},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Step 2 — alternative to Sinistral Necro combo depending on prices",opt:1},
  {l:"Omen of Greater Exaltation",id:"omen-of-greater-exaltation",c:"o",n:"Step 3 — pair with exalt to fill last 2 affixes"},
  {l:"Greater Exalted Orb",id:"greater-exalted-orb",c:"b",n:"Step 3 — cheaper exalt option"},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Step 3 — better exalt option",opt:1},
]},
{T:"Quiver — ilvl 75 (Budget / Main)",D:"RNG-heavy. Target: flat dmg or inc bow dmg prefix + +1 / crit / atk spd suffix.",I:[
  {l:"Perfect Orb of Transmutation",id:"perfect-orb-of-transmutation",c:"b",n:"Step 1 — trans the base"},
  {l:"Perfect Orb of Augmentation",id:"perfect-orb-of-augmentation",c:"b",n:"Step 1 — aug after trans"},
  {l:"Perfect Regal Orb",id:"perfect-regal-orb",c:"b",n:"Step 2 — regal for 3rd affix"},
  {l:"Greater Chaos Orb",id:"greater-chaos-orb",c:"b",n:"Step 3 — replace bad affix (2/3 brick risk)",opt:1},
  {l:"Dextral Necromancy",id:"omen-of-dextral-necromancy",c:"o",n:"Step 4 — jawbone the suffix"},
  {l:"Jawbone",id:"gnawed-jawbone",c:"b",n:"Step 4 — bone used with Dextral Necromancy"},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Step 4 — use if you land 3 GG mods",opt:1},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Step 5 — finish craft if good suffix hit",opt:1},
  {l:"Omen of Dextral Exaltation",id:"omen-of-dextral-exaltation",c:"o",n:"Step 5 — double exalt omen (suffix-targeting)",opt:1},
]},
{T:"Quiver — ilvl 75 (Expensive / High Ceiling)",D:"Needs +2 lvls/crit suffix + T1 flat. Fracture + dual omen combo.",I:[
  {l:"Jawbone",id:"gnawed-jawbone",c:"b",n:"Jawbone the suffix before fracturing"},
  {l:"Fracturing Orb",id:"fracturing-orb",c:"b",n:"1/3 to fracture flat dmg — miss = fall back to budget method"},
  {l:"Exalted Orb",id:"exalted",c:"b",n:"Exalt 1 prefix mod after fracture"},
  {l:"Essence of Hysteria",id:"essence-of-hysteria",c:"e",n:"Paired with Sinistral Crystallisation — 100% chance for bow dmg prefix"},
  {l:"Omen of Sinistral Crystallisation",id:"omen-of-sinistral-crystallisation",c:"o",n:"Paired with Essence of Hysteria (guide calls this 'sinistral crystal')"},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Slam last prefix — pray for no accuracy roll"},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Last suffix cycling — target crit or atk spd",opt:1},
  {l:"Omen of Light",id:"omen-of-light",c:"o",n:"Last suffix cycling — target crit or atk spd",opt:1},
  {l:"Omen of Whittling",id:"omen-of-whittling",c:"o",n:"Last suffix cycling — alternative omen ('whittles' in guide)",opt:1},
]},
{T:"Amulet — ilvl 80 / 82",D:"Mostly deterministic but expensive. ilvl 82 = T1 resists. Needs 1 fractured +3 proj base.",I:[
  {l:"Fracturing Orb",id:"fracturing-orb",c:"b",n:"Step 1 — fracture +3 proj (or buy pre-fractured base)"},
  {l:"Chaos Orb (spam)",id:"chaos",c:"b",n:"Step 3 — spam until T1 or T2 spirit (variable qty — budget 10-30+)"},
  {l:"Omen of Dextral Exaltation",id:"omen-of-dextral-exaltation",c:"o",n:"Steps 4 & 7 — suffix-targeting exalt"},
  {l:"Exalted Orb",id:"exalted",c:"b",n:"Step 4 — add 1 suffix (used with Dextral Exaltation)"},
  {l:"Omen of Dextral Crystallisation",id:"omen-of-dextral-crystallisation",c:"o",n:"Step 5 — paired with Essence of Enhancement"},
  {l:"Essence of Enhancement",id:"essence-of-enhancement",c:"e",n:"Step 5 — paired with Dextral Crystallisation"},
  {l:"Tul's Catalyst (Ice Resist)",id:"tuls-catalyst",c:"k",n:"Step 6 — quality to 20% (pick your resist type)",opt:1},
  {l:"Xoph's Catalyst (Fire Resist)",id:"xophs-catalyst",c:"k",n:"Step 6 — fire resist quality alt",opt:1},
  {l:"Esh's Catalyst (Lightning Resist)",id:"eshs-catalyst",c:"k",n:"Step 6 — lightning resist quality alt",opt:1},
  {l:"Collarbone",id:"gnawed-collarbone",c:"b",n:"Step 9 — remove a bad mod (cheapest tier shown)",opt:1},
  {l:"Dextral Necromancy",id:"omen-of-dextral-necromancy",c:"o",n:"Step 9 — used with Collarbone",opt:1},
  {l:"Omen of Light",id:"omen-of-light",c:"o",n:"Step 9 — target specific prefix to remove",opt:1},
]},
{T:"Helmet — ilvl 78 (Safe / Cheap)",D:"Consistent method. Start with T1 +energy shield base.",I:[
  {l:"Greater Essence of Enhancement",id:"greater-essence-of-enhancement",c:"e",n:"Step 2 — deterministic mod"},
  {l:"Sinistral Necromancy",id:"omen-of-sinistral-necromancy",c:"o",n:"Step 3 — unveil a prefix"},
  {l:"Preserved Rib",id:"preserved-rib",c:"b",n:"Step 3 — bone used with Sinistral Necromancy"},
  {l:"Greater Exalted Orb",id:"greater-exalted-orb",c:"b",n:"Step 5 — finish suffixes (hybrid %ES not T1)"},
  {l:"Perfect Exalted Orb",id:"perfect-exalted-orb",c:"b",n:"Step 5 — use instead if hybrid was T1",opt:1},
  {l:"Omen of Greater Exaltation",id:"omen-of-greater-exaltation",c:"o",n:"Step 5 — upgrade exalt tier",opt:1},
  {l:"Vaal Armourer's Infuser",id:"vaal-armourers-infuser",c:"b",n:"Step 6 — corrupt without bricking (add socket first)",opt:1},
]},
{T:"Helmet — ilvl 78 (RNG / Triple T1 Gamble)",D:"Same cost floor, higher ceiling. Can land triple T1 prefix.",I:[
  {l:"Perfect Orb of Transmutation",id:"perfect-orb-of-transmutation",c:"b",n:"Step 1 — trans/aug base until T1 %ES or +ES"},
  {l:"Perfect Orb of Augmentation",id:"perfect-orb-of-augmentation",c:"b",n:"Step 1 — aug after trans"},
  {l:"Greater Essence of Enhancement",id:"greater-essence-of-enhancement",c:"e",n:"Step 2 — use if prefix+suffix are good (resist/rarity variant)",opt:1},
  {l:"Sinistral Necromancy",id:"omen-of-sinistral-necromancy",c:"o",n:"Step 3 — unveil a prefix"},
  {l:"Preserved Rib",id:"preserved-rib",c:"b",n:"Step 3 — bone used with Sinistral Necromancy"},
  {l:"Greater Exalted Orb",id:"greater-exalted-orb",c:"b",n:"Step 3 — slam a suffix"},
  {l:"Omen of Greater Exaltation",id:"omen-of-greater-exaltation",c:"o",n:"Step 3 — pair with Greater Exalt"},
  {l:"Abyssal Echoes",id:"omen-of-abyssal-echoes",c:"o",n:"Step 4 — try to replace a bad affix",opt:1},
  {l:"Vaal Armourer's Infuser",id:"vaal-armourers-infuser",c:"b",n:"Step 5 — corrupt if prefixes are high tier",opt:1},
]},
];

const BC={e:"be",o:"bo",b:"bc",k:"bk",bb:"bb"};
const BL={e:"essence",o:"omen",b:"currency",k:"catalyst",bb:"bone"};

function fc(v){return v>=10?Math.round(v)+"c":v.toFixed(1)+"c";}

const grid=document.getElementById("g");
for(const craft of CRAFTS){
  let tot=0;
  let rows="";
  for(const item of craft.I){
    const f=P[item.id];
    let ph;
    if(f){
      ph='<div class="pc">'+fc(f.c)+'</div>';
      if(DV>0) ph+='<div class="pd">'+(f.c/DV).toFixed(2)+'d</div>';
      if(!item.opt) tot+=f.c;
    } else {
      ph='<div class="pm">not found (id: '+item.id+')</div>';
    }
    rows+='<div class="row'+(item.opt?" opt":"")+'"><div class="il"><div class="in"><span class="lbl">'+item.l+'</span><span class="bdg '+BC[item.c]+'">'+BL[item.c]+'</span>'+(item.opt?'<span class="ot">optional</span>':'')+'</div><div class="nt">'+item.n+'</div></div><div class="ip">'+ph+'</div></div>';
  }
  const dv=DV>0?'<span class="fd">/ '+(tot/DV).toFixed(2)+'d</span>':"";
  const card=document.createElement("div");
  card.className="card";
  card.innerHTML='<div class="ch"><div class="ct">'+craft.T+'</div><div class="cd">'+craft.D+'</div></div><div>'+rows+'</div><div class="cf"><span class="fl">Required floor (no optionals)</span><span><span class="ft">'+Math.round(tot)+'c</span>'+dv+'</span></div>';
  grid.appendChild(card);
}
</script>
</body>
</html>
'@

$html = $html.Replace("{{LEAGUE}}", $League)
$html = $html.Replace("{{TS}}",     $timestamp)
$html = $html.Replace("{{DIVINE}}", [Math]::Round($divineRate).ToString())
$html = $html.Replace("{{ITEMS}}",  $itemsJson.Replace("'", "\'"))
$html = $html.Replace("{{DIVVAL}}", $divineRate.ToString())

$html | Out-File -FilePath $outPath -Encoding UTF8 -NoNewline
Write-Host "  Saved: $outPath" -ForegroundColor Green
Write-Host ""
Start-Process $outPath
