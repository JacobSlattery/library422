<#
.SYNOPSIS
Produce the public-release artifacts into dist/:
  dist/library422-<version>.apk   signed release APK (needs android-app/android/app/keystore.properties)
  dist/site/                      the PWA as static files (app/ incl. data/) — what the
                                  deploy workflow publishes to library422.org (DEPLOY.md)

Run AFTER `pixi run build-data` (fresh bundle) and `pixi run smoke` (green).

.EXAMPLE
.\tools\build_release.ps1            # APK + site
.\tools\build_release.ps1 -NoSite    # APK only
#>
param([switch]$NoSite)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$env:JAVA_HOME = Join-Path $root ".pixi\envs\default\Library"
$env:ANDROID_HOME = "C:\Users\timbe\android-sdk"
$ver = Get-Content (Join-Path $root "app\version.json") -Raw | ConvertFrom-Json
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null

# manifests and version stamps must agree before anything ships
if (-not (Test-Path (Join-Path $root "app\data\manifest.json"))) { throw "app/data/manifest.json missing — run pixi run build-data" }
$keystore = Join-Path $root "android-app\android\app\keystore.properties"
if (-not (Test-Path $keystore)) { throw "no keystore.properties — the release APK would be unsigned (see app/build.gradle)" }

# same web-asset refresh + version stamp as the debug build
& (Join-Path $PSScriptRoot "build_android.ps1") | Out-Null

Push-Location (Join-Path $root "android-app\android")
try {
    & .\gradlew.bat assembleRelease --no-daemon -q
    if ($LASTEXITCODE -ne 0) { throw "gradle assembleRelease failed" }
} finally { Pop-Location }

$apk = Join-Path $root "android-app\android\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) { throw "release APK not produced (unsigned builds land as app-release-unsigned.apk)" }
$out = Join-Path $dist "library422-$($ver.version).apk"
Copy-Item $apk $out -Force
# prove the signature with the SDK's apksigner
$apksigner = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Recurse -Filter apksigner.bat | Sort-Object FullName -Descending | Select-Object -First 1
if ($apksigner) {
    & $apksigner.FullName verify --print-certs $out | Select-String "Signer|SHA-256" | ForEach-Object { $_.Line.Trim() }
}
"APK: $out ($([math]::Round((Get-Item $out).Length/1MB,1)) MB)"

if (-not $NoSite) {
    # the same assembly the deploy workflow runs (DEPLOY.md): app/ + data + _headers
    pixi run python tools/build_site.py --out (Join-Path $dist "site")
    if ($LASTEXITCODE -ne 0) { throw "build_site.py failed" }
}
