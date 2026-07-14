$swPath = "service-worker.js"
$htmlPath = "index.html"

if (-not (Test-Path $swPath) -or -not (Test-Path $htmlPath)) {
    exit 0
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$today = Get-Date -Format "ddMMyyyy"

$swContent = [System.IO.File]::ReadAllText($swPath, $utf8NoBom)

if ($swContent -match 'const CACHE_NAME = "video-proof-cache-(?<date>\d{8})-(?<rev>\d+)";') {
    $lastDate = $matches['date']
    $lastRev = [int]$matches['rev']
    
    if ($lastDate -eq $today) {
        $newRev = $lastRev + 1
    } else {
        $newRev = 1
    }
} else {
    $newRev = 1
}

$newVersion = "$today-$newRev"
$newCacheName = "video-proof-cache-$newVersion"

$swContent = $swContent -replace 'const CACHE_NAME = ".*";', "const CACHE_NAME = `"$newCacheName`";"
[System.IO.File]::WriteAllText($swPath, $swContent, $utf8NoBom)

$htmlContent = [System.IO.File]::ReadAllText($htmlPath, $utf8NoBom)
if ($htmlContent -match '<span id="app-version">.*?</span>') {
    $htmlContent = $htmlContent -replace '<span id="app-version">.*?</span>', "<span id=`"app-version`">v$newVersion</span>"
} else {
    $htmlContent = $htmlContent -replace '</body>', "<div style=`"text-align:center;font-size:11px;color:var(--text-dim);padding:10px 0;`">Phi&#234;n b&#7843;n: <span id=`"app-version`">v$newVersion</span></div>`n</body>"
}
[System.IO.File]::WriteAllText($htmlPath, $htmlContent, $utf8NoBom)

git add $swPath $htmlPath
