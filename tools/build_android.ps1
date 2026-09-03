<#
.SYNOPSIS
Build the Android APK from the current app/ + app/data/ bundle.

Steps: refresh android-app/www from app/, capacitor sync, gradle assembleDebug.
If data changed, run the FULL chain first: `pixi run build-data`
(build-db -> build-works -> embed -> build-items -> check-db -> bundle).
The APK bundles the whole catalog in app/data/; first launch installs the core + defaults, the rest is a tap away (offline).

.EXAMPLE
.\tools\build_android.ps1            # build only
.\tools\build_android.ps1 -Install   # build + adb install -r + launch
#>
param([switch]$Install)

$root = Split-Path $PSScriptRoot -Parent
$env:JAVA_HOME = Join-Path $root ".pixi\envs\default\Library"
$env:ANDROID_HOME = "C:\Users\timbe\android-sdk"

# stamp the Android version from app/version.json (single source of truth)
$ver = Get-Content (Join-Path $root "app\version.json") -Raw | ConvertFrom-Json
$gradle = Join-Path $root "android-app\android\app\build.gradle"
$g = Get-Content $gradle -Raw
$g = $g -replace 'versionCode \d+', "versionCode $($ver.code)"
$g = $g -replace 'versionName "[^"]*"', "versionName `"$($ver.version)`""
Set-Content -Path $gradle -Value $g -NoNewline
"Version $($ver.version) (code $($ver.code))"

# refresh web assets (sw.js excluded: assets are bundled, no service worker needed)
$www = Join-Path $root "android-app\www"
if (Test-Path $www) { Remove-Item -Recurse -Force $www }
Copy-Item -Recurse (Join-Path $root "app") $www
Remove-Item -Force (Join-Path $www "sw.js") -ErrorAction SilentlyContinue

Push-Location (Join-Path $root "android-app")
try {
    pixi run -- npx cap sync android
    Push-Location android
    try {
        & .\gradlew.bat assembleDebug --no-daemon
        if ($LASTEXITCODE -ne 0) { throw "gradle build failed" }
    } finally { Pop-Location }
} finally { Pop-Location }

$apk = Join-Path $root "android-app\android\app\build\outputs\apk\debug\app-debug.apk"
"APK: $apk ($([math]::Round((Get-Item $apk).Length/1MB,1)) MB)"

if ($Install) {
    adb install -r $apk
    adb shell monkey -p org.library422.study -c android.intent.category.LAUNCHER 1 | Out-Null
    "Installed and launched on device."
}
