$league = "Runes of Aldur"

# ---- tunables -------------------------------------------------------------
$tradeMinGapMs   = 1000    # minimum ms between trade2 SEARCH calls.
                           #   Lower = faster but more likely to hit 429 (which now
                           #   auto-recovers). Raise if you still get rate limited.
$minNinjaVolume  = 10      # if a poe.ninja listing's trade volume is below this, treat
                           #   its price as unreliable and price the item via trade2.
$showNinjaFields = $false  # set $true ONCE and rerun to print a poe.ninja line's field
                           #   names (helps confirm the real volume field, see notes).
# ---------------------------------------------------------------------------

# Put a real contact here. GGG asks third-party tools to identify themselves.
$headers = @{ "User-Agent" = "poe-price-check/1.0 (contact: you@example.com)" }

# Smart throttle: only sleeps for the time still remaining since the last trade2
# call, so time spent on poe.ninja / parsing counts toward the gap and the first
# call never waits at all.
$script:lastTradeCall = [datetime]::MinValue
function Wait-TradeThrottle {
    $elapsed = ([datetime]::Now - $script:lastTradeCall).TotalMilliseconds
    if ($elapsed -lt $tradeMinGapMs) {
        Start-Sleep -Milliseconds ([int]($tradeMinGapMs - $elapsed))
    }
    $script:lastTradeCall = [datetime]::Now
}

# Wrapper for pathofexile.com trade calls: sends the User-Agent and automatically
# waits + retries on 429 (rate limit) instead of failing.
function Invoke-PoeTrade {
    param([string]$Uri, [string]$Method = "Get", $Body = $null)

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            if ($Method -eq "Post") {
                return Invoke-RestMethod -Uri $Uri -Method Post -ContentType "application/json" -Body $Body -Headers $headers -ErrorAction Stop
            }
            return Invoke-RestMethod -Uri $Uri -Headers $headers -ErrorAction Stop
        }
        catch {
            $code = 0
            try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            if ($code -eq 429) {
                $wait = 8
                try { if ($_.Exception.Response.Headers["Retry-After"]) { $wait = [int]$_.Exception.Response.Headers["Retry-After"] } } catch {}
                Write-Host "  429 rate limited; waiting $($wait + 1)s..." -ForegroundColor DarkYellow
                Start-Sleep -Seconds ($wait + 1)
                continue
            }
            throw
        }
    }
    throw "Gave up after repeated 429s: $Uri"
}

# poe.ninja exchange lines carry a trade-volume number, but the exact field name
# has shifted over time. Probe the likely candidates; return -1 if none is found
# (in which case we just trust the poe.ninja price as before).
function Get-LineVolume($line) {
    foreach ($f in @("volume","count","totalVolume","accepted","listingCount","dataPointCount")) {
        $p = $line.PSObject.Properties[$f]
        if ($p -and $null -ne $p.Value) {
            $v = 0.0
            if ([double]::TryParse([string]$p.Value, [ref]$v)) { return $v }
        }
    }
    return -1
}

$categories = @(
    @{ Type = "Currency"; Slug = "currency" },
    @{ Type = "Fragments"; Slug = "fragments" },
    @{ Type = "Abyssal Bones"; Slug = "abyssal-bones" },
    @{ Type = "UncutGems"; Slug = "uncut-gems" },
    @{ Type = "Essences"; Slug = "essences" },
    @{ Type = "Soul Cores"; Slug = "soul-cores" },
    @{ Type = "Idols"; Slug = "idols" },
    @{ Type = "Runes"; Slug = "runes" },
    @{ Type = "Omens"; Slug = "omens" },
    @{ Type = "Expedition"; Slug = "expedition" },
    @{ Type = "Liquid Emotions"; Slug = "liquid-emotions" },
    @{ Type = "Breach Catalysts"; Slug = "breach-catalysts" },
    @{ Type = "Catalysts"; Slug = "breach-catalysts" },
    @{ Type = "Verisium"; Slug = "verisium" }
)

function Normalize-Name($s) {
    # \u2019 is the curly apostrophe; written as a regex escape so the file stays pure ASCII.
    return ($s.ToLower() -replace "[\u2019']", "" -replace "[\(\)]", " " -replace "[^a-z0-9]+", " " -replace "\s+", " ").Trim()
}

function Strip-Quantity($s) {
    $lineText = $s.Trim()
    $qty = 1

    if ($lineText -match "^\s*([0-9Il\|l]+)\s*x\s+(.+)$") {
        $qtyText = $matches[1] -replace "[Il\|l]", "1"
        $qty = [int]$qtyText
        $lineText = $matches[2].Trim()
    }

    return @{
        Qty = $qty
        Text = $lineText
    }
}

function Get-DisplayPriceExalted($line, $currencyRates) {
    if (-not $line.maxVolumeRate -or [double]$line.maxVolumeRate -eq 0) {
        return 0
    }

    $amount = 1 / [double]$line.maxVolumeRate
    $currency = [string]$line.maxVolumeCurrency

    if ($currency -eq "exalted") {
        return [math]::Round($amount, 2)
    }

    if ($currencyRates.ContainsKey($currency)) {
        return [math]::Round($amount * [double]$currencyRates[$currency], 2)
    }

    return 0
}

function Get-TradePrice($name, $league, $currencyRates) {
    try {
        $body = @{
            query = @{
                type = $name
                stats = @(
                    @{
                        type = "and"
                        filters = @()
                    }
                )
                status = @{
                    option = "any"
                }
            }
            sort = @{
                price = "asc"
            }
        } | ConvertTo-Json -Depth 10

        $searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/$([uri]::EscapeDataString($league))"

        Wait-TradeThrottle
        $search = Invoke-PoeTrade -Uri $searchUrl -Method Post -Body $body

        if (-not $search.result -or $search.result.Count -eq 0) {
            return $null
        }

        $ids = ($search.result | Select-Object -First 10) -join ","
        $fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/${ids}?query=$($search.id)"
        $fetch = Invoke-PoeTrade -Uri $fetchUrl

        $prices = @()

        foreach ($entry in $fetch.result) {
            if (-not $entry.listing.price) {
                continue
            }

            $amount = [double]$entry.listing.price.amount
            $currency = [string]$entry.listing.price.currency

            if (-not $currencyRates.ContainsKey($currency)) {
                continue
            }

            $exaltedTotal = [math]::Round($amount * [double]$currencyRates[$currency], 2)

            if ($exaltedTotal -le 0) {
                continue
            }

            $prices += [PSCustomObject]@{
                Each = $exaltedTotal
                RawAmount = $amount
                RawCurrency = $currency
            }
        }

        if (-not $prices -or $prices.Count -eq 0) {
            return $null
        }

        return $prices | Sort-Object Each | Select-Object -First 1
    }
    catch {
        return $null
    }
}

$text = Get-Clipboard

$rawLines = $text -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object {
        $_.Length -gt 0 -and
        $_ -notmatch "Runeshape" -and
        $_ -notmatch "Combination" -and
        $_ -notmatch "Game Paused"
    }

if (-not $rawLines) {
    Write-Host "No usable names found in clipboard."
    Write-Host "Clipboard was:"
    Write-Host $text
    pause
    exit
}

Write-Host "Loading poe.ninja categories..." -ForegroundColor Cyan

$all = @()
$currencyData = $null
$currencyRates = @{}

$currencyRates["exalted"] = 1.0

foreach ($cat in $categories) {
    $url = "https://poe.ninja/poe2/api/economy/exchange/current/overview?league=$([uri]::EscapeDataString($league))&type=$([uri]::EscapeDataString($cat.Type))"

    try {
        $data = Invoke-RestMethod $url
    }
    catch {
        continue
    }

    if ($cat.Type -eq "Currency") {
        $currencyData = $data
    }

    foreach ($item in $data.items) {
        $line = $data.lines | Where-Object { $_.id -eq $item.id } | Select-Object -First 1
        if (-not $line) { continue }

        if ($showNinjaFields) {
            Write-Host "poe.ninja line fields for '$($item.name)':" -ForegroundColor Magenta
            $line.PSObject.Properties | ForEach-Object { Write-Host ("  {0} = {1}" -f $_.Name, $_.Value) }
            $showNinjaFields = $false
        }

        $displayPrice = if ($line.maxVolumeRate -and $line.maxVolumeRate -ne 0) {
            [math]::Round((1 / [double]$line.maxVolumeRate), 2)
        } else {
            0
        }

        $all += [PSCustomObject]@{
            Name = $item.name
            NormalizedName = Normalize-Name $item.name
            Category = $cat.Type
            Slug = $cat.Slug
            Price = $displayPrice
            Currency = $line.maxVolumeCurrency
            Volume = Get-LineVolume $line
            DivineValue = [math]::Round([double]$line.primaryValue, 4)
            Change7d = "$($line.sparkline.totalChange)%"
            Id = $item.id
            # Raw poe.ninja line, kept so the price can be converted to exalted at
            # match time (currency rates aren't loaded yet at this point in the run).
            Line = $line
        }
    }
}

if ($currencyData) {
    if ($currencyData.core.rates.exalted) {
        $currencyRates["divine"] = [double]$currencyData.core.rates.exalted
    }

    if ($currencyData.core.rates.chaos) {
        $currencyRates["chaos"] = [math]::Round((1 / [double]$currencyData.core.rates.chaos), 6)
    }

    foreach ($item in $currencyData.items) {
        $line = $currencyData.lines | Where-Object { $_.id -eq $item.id } | Select-Object -First 1
        if (-not $line) { continue }

        $priceEx = Get-DisplayPriceExalted $line $currencyRates

        if ($priceEx -gt 0) {
            $currencyRates[$item.id] = $priceEx
            $currencyRates[(Normalize-Name $item.name)] = $priceEx
        }
    }

    $manualAliases = @{
        "alch" = "orb of alchemy"
        "alchemy" = "orb of alchemy"
        "regal" = "regal orb"
        "annul" = "orb of annulment"
        "chance" = "orb of chance"
        "transmute" = "orb of transmutation"
        "augmentation" = "orb of augmentation"
        "aug" = "orb of augmentation"
        "vaal" = "vaal orb"
        "gcp" = "gemcutter's prism"
        "gemcutter" = "gemcutter's prism"
    }

    foreach ($alias in $manualAliases.Keys) {
        $normTarget = Normalize-Name $manualAliases[$alias]
        if ($currencyRates.ContainsKey($normTarget)) {
            $currencyRates[$alias] = $currencyRates[$normTarget]
        }
    }
}

$all = $all | Sort-Object Name, Category -Unique

$seenCleanNames = @{}

$result = foreach ($rawName in $rawLines) {
    $parsed = Strip-Quantity $rawName
    $qty = $parsed.Qty
    $lineText = $parsed.Text.Trim()

    # \u2022 is the bullet char; written as a regex escape so the file stays pure ASCII.
    $cleanName = ($lineText -replace "^\s*[|:\-\u2022]*\s*", "" -replace "^\s*(Skill|Support)\s*:\s*", "" -replace "\s+", " ").Trim()

    if ($cleanName.Length -lt 3) {
        continue
    }

    if ($cleanName -notmatch "[A-Za-z]") {
        continue
    }

    if ($cleanName -match "^Uncut (Skill|Spirit|Support) Gem$") {
        continue
    }

    $norm = Normalize-Name $cleanName

    if ($seenCleanNames.ContainsKey($norm)) {
        continue
    }

    $seenCleanNames[$norm] = $true

    $match = $all | Where-Object { $_.NormalizedName -eq $norm } | Select-Object -First 1

    if (-not $match -and $cleanName -notmatch "^Uncut (Skill|Spirit|Support) Gem$") {
        $match = $all |
            Where-Object {
                ($norm.Length -ge 6) -and
                ($_.NormalizedName.Contains($norm) -or $norm.Contains($_.NormalizedName))
            } |
            Sort-Object { $_.NormalizedName.Length } |
            Select-Object -First 1
    }

    if ($match) {
        $lowVol = ($match.Volume -ge 0 -and $match.Volume -lt $minNinjaVolume)

        if ($lowVol) {
            # poe.ninja price is based on too few trades -> prefer a live trade2 price.
            $tp = Get-TradePrice $cleanName $league $currencyRates
            if ($tp) {
                $each = [double]$tp.Each
                $total = [math]::Round($each * $qty, 2)

                [PSCustomObject]@{
                    Qty = $qty
                    Name = $match.Name
                    Category = "$($match.Category) (low vol -> trade2)"
                    Each = $each
                    Total = $total
                    Currency = "exalted"
                    Source = "trade2"
                    RawPrice = "$($tp.RawAmount) $($tp.RawCurrency)"
                    DivineValue = ""
                    Change7d = $match.Change7d
                }

                continue
            }
            # trade2 had nothing usable -> fall through to the (low-volume) ninja price.
        }

        # $match.Price (1/maxVolumeRate) is denominated in the line's maxVolumeCurrency
        # — DIVINE for high-value items like omens, not exalted. Convert with the same
        # helper the currency-rate table uses, so Each/Total are truly exalted and sort
        # correctly against the genuinely-exalted trade2 rows below.
        $each = Get-DisplayPriceExalted $match.Line $currencyRates
        $total = [math]::Round(([double]$each * $qty), 2)

        [PSCustomObject]@{
            Qty = $qty
            Name = $match.Name
            Category = if ($lowVol) { "$($match.Category) (low vol)" } else { $match.Category }
            Each = $each
            Total = $total
            Currency = "exalted"
            Source = "poe.ninja"
            RawPrice = ""
            DivineValue = $match.DivineValue
            Change7d = $match.Change7d
        }

        continue
    }

    $tradePrice = Get-TradePrice $cleanName $league $currencyRates

    if ($tradePrice) {
        $each = [double]$tradePrice.Each
        $total = [math]::Round($each * $qty, 2)

        [PSCustomObject]@{
            Qty = $qty
            Name = $cleanName
            Category = "TradeMarket"
            Each = $each
            Total = $total
            Currency = "exalted"
            Source = "trade2"
            RawPrice = "$($tradePrice.RawAmount) $($tradePrice.RawCurrency)"
            DivineValue = ""
            Change7d = ""
        }

        continue
    }

    [PSCustomObject]@{
        Qty = $qty
        Name = $cleanName
        Category = "NOT FOUND"
        Each = ""
        Total = ""
        Currency = ""
        Source = ""
        RawPrice = ""
        DivineValue = ""
        Change7d = ""
    }
}

$sortedResult = $result |
    Sort-Object @{
        Expression = {
            if ($_.Total -is [double] -or $_.Total -is [decimal] -or $_.Total -is [int]) {
                [double]$_.Total
            } else {
                -1
            }
        }
        Descending = $true
    }

$sortedResult | Format-Table Qty, Name, Category, Each, Total, Currency, Source, RawPrice, Change7d -AutoSize

$best = $sortedResult |
    Where-Object {
        ($_.Total -is [double] -or $_.Total -is [decimal] -or $_.Total -is [int]) -and
        [double]$_.Total -gt 0
    } |
    Select-Object -First 1

if ($best) {
    Write-Host ""
    Write-Host "BEST PICK: $($best.Qty)x $($best.Name) - $($best.Total) exalted [$($best.Category), $($best.Source)]" -ForegroundColor Green

    if ($best.RawPrice) {
        Write-Host "Raw listing: $($best.RawPrice)" -ForegroundColor DarkGray
    }
}

pause