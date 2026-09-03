# Acquisition only (Rule 1): downloads NEW Sefaria texts. Files that already
# exist are pinned in integrity/MANIFEST.sha256 and are never overwritten here;
# delete one deliberately (then rebuild the manifest) if a refresh is wanted.
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repo "resources\jewish-texts\sefaria"
$dataRoot = Join-Path $repo "resources\jewish-texts\sefaria-texts"
$books = (Get-Content "$root\books.json" -Raw | ConvertFrom-Json).books

$talmudPick = @('Berakhot','Shabbat','Pesachim','Yoma','Sukkah','Sanhedrin')

$wanted = $books | Where-Object {
    ($_.categories -contains 'Targum' -and $_.categories -notcontains 'Commentary') -or
    ($_.categories[0] -eq 'Mishnah' -and $_.categories -notcontains 'Commentary' -and $_.categories.Count -le 2) -or
    ($_.categories[0] -eq 'Talmud' -and $_.categories -contains 'Bavli' -and $_.categories -notcontains 'Commentary' -and $_.title -in $talmudPick)
}

# One merged.json per unique book+language directory
$dirs = $wanted | ForEach-Object {
    $_.json_url.Substring(0, $_.json_url.LastIndexOf('/'))
} | Sort-Object -Unique

"Downloading $($dirs.Count) merged texts..."
$ok = 0; $fail = 0; $skip = 0
foreach ($d in $dirs) {
    $rel = $d -replace '^https://storage\.googleapis\.com/sefaria-export/json/', ''
    $dest = Join-Path $dataRoot $rel
    $target = Join-Path $dest 'merged.json'
    if (Test-Path $target) { $skip++; continue }      # pinned source: keep it
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $url = ($d + '/merged.json') -replace ' ', '%20'
    $tmp = "$target.part"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
        Move-Item -Force $tmp $target
        $ok++
    } catch {
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
        $fail++
        "MISS: $rel"
    }
}
"Done. OK=$ok FAIL=$fail SKIPPED(existing)=$skip"
if ($ok -gt 0) { "New files downloaded — run: pixi run python tools/build_manifest.py" }
