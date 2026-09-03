<#
.SYNOPSIS
Look up a verse across the JSON translations in texts/.

.EXAMPLE
.\Get-Verse.ps1 -Book Genesis -Chapter 1 -Verse 1
.\Get-Verse.ps1 -Book John -Chapter 1 -Verse 1 -Versions kjv,ylt,westcotthort
#>
param(
    [Parameter(Mandatory)][string]$Book,
    [Parameter(Mandatory)][int]$Chapter,
    [Parameter(Mandatory)][int]$Verse,
    [string[]]$Versions
)

$textsDir = Join-Path $PSScriptRoot "..\texts"
$files = Get-ChildItem $textsDir -Recurse -Filter *.json -Depth 1 |
    Where-Object { $_.Directory.Name -in @('english','greek','hebrew') }

if ($Versions) {
    $files = $files | Where-Object { $_.BaseName -in $Versions }
}

# Resolve English book name -> standard book number (consistent across all texts)
$kjv = Get-Content (Join-Path $textsDir "english\kjv.json") -Raw | ConvertFrom-Json
$ref = $kjv.books | Where-Object { $_.name -like "$Book*" } | Select-Object -First 1
if (-not $ref) { Write-Error "Book '$Book' not found."; return }
$bookNr = $ref.nr

foreach ($f in $files) {
    $bible = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $b = $bible.books | Where-Object { $_.nr -eq $bookNr } | Select-Object -First 1
    if (-not $b) { continue }
    $v = ($b.chapters | Where-Object chapter -eq $Chapter).verses |
         Where-Object verse -eq $Verse
    if ($v) {
        "{0,-16} {1} {2}:{3}  {4}" -f $f.BaseName.ToUpper(), $b.name, $Chapter, $Verse, $v.text.Trim()
    }
}
