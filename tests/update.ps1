# Checks update availability and the Windows installer handoff using local files only.
param([string]$Bin = (Join-Path $PSScriptRoot '..\target\release\mermdraw.exe'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Bin)) { throw "FAIL: no executable at $Bin" }
$Bin = (Resolve-Path -LiteralPath $Bin).ProviderPath
$current = (& $Bin --version | Out-String).Trim()
$work = Join-Path ([IO.Path]::GetTempPath()) ('mermdraw-update-test-' + [Guid]::NewGuid().ToString('N'))
$oldUpdateUrl = $env:MERMDRAW_UPDATE_URL
$oldInstallUrl = $env:MERMDRAW_INSTALL_URL

function Expect([string]$Description, [string]$Actual, [string]$Substring) {
    if (-not $Actual.Contains($Substring)) { throw "FAIL: ${Description}: expected '$Substring' in: $Actual" }
    Write-Host "ok   $Description"
}

New-Item -ItemType Directory -Path $work | Out-Null
try {
    $api = Join-Path $work 'latest.json'
    $env:MERMDRAW_UPDATE_URL = ([Uri]$api).AbsoluteUri
    Set-Content -LiteralPath $api -Value ('{"tag_name":"v' + $current.Substring(9) + '"}') -Encoding Ascii
    $out = (& $Bin update --check | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "FAIL: --check failed: $out" }
    Expect 'reports the installed version is current' $out "$current is current"

    Set-Content -LiteralPath $api -Value '{"tag_name":"v999.0.0"}' -Encoding Ascii
    $out = (& $Bin update --check | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "FAIL: --check failed: $out" }
    Expect 'shows a newer release' $out 'Update available:'
    Expect 'suggests a manual update' $out 'mermdraw update'
    if ((& $Bin --version | Out-String).Trim() -ne $current) { throw 'FAIL: --check changed the binary' }
    Write-Host 'ok   --check leaves the binary alone'

    # An invalid checksum makes the installer stop before touching the running executable.
    $name = 'mermdraw-x86_64-pc-windows-msvc'
    $stage = Join-Path $work "stage\$name"
    $release = Join-Path $work 'releases\mermdraw\releases\download\v999.0.0'
    New-Item -ItemType Directory -Force -Path $stage, $release | Out-Null
    Copy-Item -LiteralPath $Bin -Destination (Join-Path $stage 'mermdraw.exe')
    Compress-Archive -Path $stage -DestinationPath (Join-Path $release "$name.zip")
    Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Value (('0' * 64) + "  $name.zip") -Encoding Ascii
    $env:MERMDRAW_INSTALL_URL = ([Uri](Join-Path $work 'releases')).AbsoluteUri
    $ErrorActionPreference = 'Continue'
    $out = & $Bin update --yes 2>&1 | ForEach-Object { "$_" } | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0) { throw 'FAIL: installed an archive with a bad checksum' }
    Expect 'refuses a bad checksum' $out 'checksum mismatch'
    if ((& $Bin --version | Out-String).Trim() -ne $current) { throw 'FAIL: bad archive changed the binary' }
    Write-Host 'ok   failed verification leaves the binary alone'

    $correctHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $release "$name.zip")).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Value "$correctHash  $name.zip" -Encoding Ascii
    $ErrorActionPreference = 'Continue'
    $out = & $Bin update --yes 2>&1 | ForEach-Object { "$_" } | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0) { throw 'FAIL: installed a binary with the wrong version' }
    Expect 'restores the old binary when the archive reports the wrong version' $out 'the previous binary was restored'
    if ((& $Bin --version | Out-String).Trim() -ne $current) { throw 'FAIL: wrong-version archive changed the binary' }
    Write-Host 'ok   failed update preserves the original executable'
    Write-Host 'update test passed'
} finally {
    $env:MERMDRAW_UPDATE_URL = $oldUpdateUrl
    $env:MERMDRAW_INSTALL_URL = $oldInstallUrl
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
