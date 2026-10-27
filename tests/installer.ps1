# Tests scripts/install.ps1 against a local copy of a release (MERMDRAW_INSTALL_URL=file:///...), as tests/installer.sh
# does for install.sh: checksums, the attestation check (with a stand-in gh), -Version, -Dir, the environment
# variables, irm | iex, replacing a running mermdraw.exe, and the user PATH. Run it with both Windows PowerShell 5.1
# and PowerShell 7; it runs the installer in a child process of the same kind. It changes your user PATH only on CI,
# and puts it back afterwards.
# usage: tests/installer.ps1 [path\to\mermdraw.exe]      (default: target\release\mermdraw.exe)
param([string]$Bin = (Join-Path $PSScriptRoot '..\target\release\mermdraw.exe'))
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$installer = Join-Path $root 'scripts\install.ps1'
if (-not (Test-Path -LiteralPath $Bin)) { throw "FAIL: no executable at $Bin (build with: cargo build --release)" }
$Bin = (Resolve-Path -LiteralPath $Bin).ProviderPath
$version = (& $Bin --version | Out-String).Trim()
$shell = (Get-Process -Id $PID).Path # powershell.exe or pwsh.exe
$work = Join-Path ([IO.Path]::GetTempPath()) ('mermdraw-installer-test-' + [Guid]::NewGuid().ToString('N'))
$name = 'mermdraw-x86_64-pc-windows-msvc'

function Fail([string]$Message) { throw "FAIL: $Message" }
function Pass([string]$Message) { Write-Host "ok   $Message" }
function Expect([string]$Description, [string]$Actual, [string]$Substring) {
    if (-not $Actual.Contains($Substring)) { Fail "${Description}: expected '$Substring' in: $Actual" }
    Pass $Description
}

# a release folder laid out like GitHub's: the zip with mermdraw.exe in its folder, and SHA256SUMS.txt
function New-Release([string]$Dir) {
    $stage = Join-Path $work ('stage-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Join-Path $stage $name), $Dir | Out-Null
    Copy-Item -LiteralPath $Bin -Destination (Join-Path $stage "$name\mermdraw.exe")
    Compress-Archive -Path (Join-Path $stage $name) -DestinationPath (Join-Path $Dir "$name.zip")
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Dir "$name.zip")).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $Dir 'SHA256SUMS.txt') -Value "$hash  $name.zip" -Encoding Ascii
}

# Runs the installer in a child PowerShell with these environment variables (and a stand-in gh first on the PATH),
# as a file with Arguments or, with -Iex, piped into Invoke-Expression as irm | iex does. Returns its exit code and
# output.
function Invoke-Installer([hashtable]$Environment = @{}, [string[]]$Arguments = @(), [switch]$Iex) {
    $vars = @{ MERMDRAW_INSTALL_URL = $script:url; FAKE_GH = '4'; Path = "$work\gh;$env:Path" }
    foreach ($k in $Environment.Keys) { $vars[$k] = $Environment[$k] }
    $saved = @{}
    foreach ($k in $vars.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process')
    }
    try {
        $ErrorActionPreference = 'Continue' # the child's errors arrive on stderr
        if ($Iex) {
            $command = "Get-Content -Raw -LiteralPath '$installer' | Invoke-Expression"
            $out = & $shell -NoProfile -ExecutionPolicy Bypass -Command $command 2>&1 | ForEach-Object { "$_" } | Out-String
        } else {
            $out = & $shell -NoProfile -ExecutionPolicy Bypass -File $installer @Arguments 2>&1 | ForEach-Object { "$_" } | Out-String
        }
        return @{ Code = $LASTEXITCODE; Out = $out }
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

New-Item -ItemType Directory -Path $work | Out-Null
$work = (Resolve-Path -LiteralPath $work).ProviderPath # the form install.ps1 prints
$userPath = (Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$server = $null
try {
    $script:url = ([Uri](Join-Path $work 'releases')).AbsoluteUri
    New-Release (Join-Path $work 'releases\mermdraw\releases\latest\download')
    New-Release (Join-Path $work 'releases\mermdraw\releases\download\v9.9.9')
    New-Release (Join-Path $work 'bad\mermdraw\releases\latest\download')
    Add-Content -LiteralPath (Join-Path $work "bad\mermdraw\releases\latest\download\$name.zip") -Value 'x'
    # a stand-in gh: exits with %FAKE_GH% (4 is gh's "not logged in")
    New-Item -ItemType Directory -Path (Join-Path $work 'gh') | Out-Null
    Set-Content -LiteralPath (Join-Path $work 'gh\gh.cmd') -Encoding Ascii -Value @(
        '@echo off', 'echo fake gh: attestation does not match 1>&2', 'exit /b %FAKE_GH%')

    # ------------------------------------------------------------ a first install, as a file with parameters
    $dir = Join-Path $work 'bin'
    $r = Invoke-Installer -Arguments @('-Dir', $dir, '-NoModifyPath')
    if ($r.Code -ne 0) { Fail "the installer failed: $($r.Out)" }
    Expect 'installs into -Dir' $r.Out "installed $version -> $dir\mermdraw.exe"
    Expect 'picks the Windows build of the latest release' $r.Out "from         $script:url/mermdraw/releases/latest/download/$name.zip"
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work "releases\mermdraw\releases\latest\download\$name.zip")).Hash.ToLowerInvariant()
    Expect 'checks the checksum' $r.Out "$hash matches SHA256SUMS.txt"
    Expect "says the attestation wasn't checked when gh isn't logged in" $r.Out 'attestation  not checked: gh is not logged in'
    Expect '-NoModifyPath says how to add the folder' $r.Out "$dir is not on your PATH"
    if ((& (Join-Path $dir 'mermdraw.exe') --version | Out-String).Trim() -ne $version) { Fail "the installed binary doesn't run" }
    Pass 'the installed binary runs'

    # ------------------------------------------------------------ irm | iex, configured by environment variables
    $r = Invoke-Installer -Iex -Environment @{
        MERMDRAW_INSTALL_VERSION = '9.9.9'; MERMDRAW_INSTALL_DIR = (Join-Path $work 'env-bin'); MERMDRAW_NO_MODIFY_PATH = '1'
    }
    if ($r.Code -ne 0) { Fail "the installer failed under Invoke-Expression: $($r.Out)" }
    Expect 'runs under Invoke-Expression, as irm | iex does' $r.Out "installed $version -> $work\env-bin\mermdraw.exe"
    Expect 'MERMDRAW_INSTALL_VERSION picks that release' $r.Out "/mermdraw/releases/download/v9.9.9/$name.zip"

    # ------------------------------------------------------------ replacing a mermdraw.exe that's running
    $server = Start-Process -FilePath (Join-Path $dir 'mermdraw.exe') -ArgumentList @("`"$work`"", '--no-open', '--new', '--port', '7931') -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 1
    $r = Invoke-Installer -Arguments @('-Dir', $dir, '-NoModifyPath', '-Version', 'v9.9.9')
    if ($r.Code -ne 0) { Fail "could not replace a running mermdraw.exe: $($r.Out)" }
    Expect 'replaces a running mermdraw.exe' $r.Out "installed $version -> $dir\mermdraw.exe"
    Stop-Process -Id $server.Id -Force
    $server = $null

    # ------------------------------------------------------------ refusals: nothing is installed
    $r = Invoke-Installer -Arguments @('-Dir', (Join-Path $work 'c'), '-NoModifyPath') -Environment @{ MERMDRAW_INSTALL_URL = ([Uri](Join-Path $work 'bad')).AbsoluteUri }
    if ($r.Code -eq 0) { Fail 'a corrupted download was installed' }
    Expect "refuses a download that doesn't match SHA256SUMS.txt" $r.Out "checksum mismatch for $name.zip"
    if (Test-Path -LiteralPath (Join-Path $work 'c\mermdraw.exe')) { Fail 'installed a corrupted download' }
    Pass 'a checksum mismatch installs nothing'
    $r = Invoke-Installer -Arguments @('-Dir', (Join-Path $work 'g'), '-NoModifyPath') -Environment @{ FAKE_GH = '1' }
    if ($r.Code -eq 0) { Fail 'installed although gh rejected the attestation' }
    Expect 'stops when gh rejects the attestation' $r.Out "gh attestation verify rejected $name.zip"
    Expect 'shows what gh said' $r.Out 'fake gh: attestation does not match'
    if (Test-Path -LiteralPath (Join-Path $work 'g\mermdraw.exe')) { Fail 'installed although gh rejected the attestation' }
    Pass 'a rejected attestation installs nothing'
    $r = Invoke-Installer -Arguments @('-Dir', (Join-Path $work 'a'), '-NoModifyPath') -Environment @{ FAKE_GH = '0' }
    Expect 'says when gh verified the attestation' $r.Out "verified with gh: built by berttoli/mermdraw's release workflow"
    $r = Invoke-Installer -Arguments @('-Dir', (Join-Path $work 'm'), '-NoModifyPath', '-Version', 'v0.0.1')
    if ($r.Code -eq 0) { Fail "installed a release that doesn't exist" }
    Expect 'says which release is missing' $r.Out 'does the v0.0.1 release have a build for x86_64-pc-windows-msvc?'

    # ------------------------------------------------------------ the user PATH, on CI only
    if ($env:CI) {
        $pathDir = Join-Path $work 'path-bin'
        $r = Invoke-Installer -Arguments @('-Dir', $pathDir)
        Expect 'adds the folder to the user PATH' $r.Out "added $pathDir to your user PATH"
        $now = (Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
        if (-not $now.StartsWith("$pathDir;")) { Fail "the user PATH doesn't start with ${pathDir}: $now" }
        $rest = @($userPath -split ';' | Where-Object { $_ }) -join ';'
        if ($rest -and -not $now.EndsWith($rest)) { Fail "the user PATH lost its other entries: $now" }
        Pass 'puts the folder first and keeps the rest of the user PATH'
        $r = Invoke-Installer -Arguments @('-Dir', $pathDir)
        Expect 'adds the folder only once' $r.Out "$pathDir is already on your user PATH"
    } else {
        Write-Host 'skip the user PATH test (it runs on CI, where changing the user PATH is harmless)'
    }
    Write-Host 'installer test passed'
} finally {
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    if ($env:CI) { Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $userPath -Type ExpandString }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
