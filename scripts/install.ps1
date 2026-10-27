# Installs mermdraw from its GitHub releases on Windows (macOS and Linux have install.sh):
#
#   powershell -ExecutionPolicy Bypass -c "irm https://github.com/berttoli/mermdraw/releases/latest/download/install.ps1 | iex"
#
# It downloads the Windows build, checks it against the release's SHA256SUMS.txt (and its build-provenance attestation
# when gh is installed and logged in), installs mermdraw.exe into ~\.local\bin and adds that folder to your user PATH.
# Run it again to update. Options, as parameters when run as a file (.\install.ps1 -Version v0.2.0) or as environment
# variables with irm | iex:
#
#   -Version TAG      MERMDRAW_INSTALL_VERSION    a release tag such as v0.2.0 (default: the latest release)
#   -Dir DIR          MERMDRAW_INSTALL_DIR        where to put mermdraw.exe (default: ~\.local\bin)
#   -NoModifyPath     MERMDRAW_NO_MODIFY_PATH=1   leave your user PATH alone
#
# MERMDRAW_INSTALL_URL replaces https://github.com/berttoli in the download URLs (file:// included), as in install.sh.
# Works in Windows PowerShell 5.1 and PowerShell 7. It throws instead of calling exit, which would close the window it
# was piped into.
param(
    [string]$Version = $env:MERMDRAW_INSTALL_VERSION,
    [string]$Dir = $env:MERMDRAW_INSTALL_DIR,
    [switch]$NoModifyPath
)

function Get-MermdrawDownload([string]$Url, [string]$OutFile) {
    $uri = [Uri]$Url
    if ($uri.IsFile) {
        Copy-Item -LiteralPath $uri.LocalPath -Destination $OutFile
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
}

# What gh says about the archive; throws if gh rejects it.
function Test-MermdrawAttestation([string]$Archive, [string]$Repo) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) {
        return 'not checked: gh is not installed (https://cli.github.com)'
    }
    # Windows PowerShell turns a native command's stderr into errors, which 'Stop' would throw on
    $ErrorActionPreference = 'Continue'
    $out = & $gh.Source attestation verify $Archive -R $Repo 2>&1 | ForEach-Object { "$_" } | Out-String
    switch ($LASTEXITCODE) {
        0 { return "verified with gh: built by $Repo's release workflow" }
        4 { return 'not checked: gh is not logged in (gh auth login)' } # gh's exit code for "not logged in"
        default {
            $indented = ($out.Trim() -split "`r?`n" | ForEach-Object { "  $_" }) -join "`n"
            throw "mermdraw installer: gh attestation verify rejected $(Split-Path -Leaf $Archive); nothing was installed`n$indented"
        }
    }
}

# Puts Folder first on the user PATH in the registry, keeping %VARIABLES% in the other entries unexpanded.
function Add-MermdrawPath([string]$Folder) {
    $key = 'HKCU:\Environment'
    $current = (Get-Item -LiteralPath $key).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $entries = @($current -split ';' | Where-Object { $_ })
    $expanded = @($entries | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
    if ($expanded -contains $Folder.TrimEnd('\')) {
        return $false
    }
    Set-ItemProperty -LiteralPath $key -Name Path -Value ((@($Folder) + $entries) -join ';') -Type ExpandString
    # setting any user variable broadcasts WM_SETTINGCHANGE, so new terminals see the new PATH
    [Environment]::SetEnvironmentVariable('MERMDRAW_INSTALLER', '1', 'User')
    [Environment]::SetEnvironmentVariable('MERMDRAW_INSTALLER', $null, 'User')
    return $true
}

function Install-Mermdraw {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # the progress bar slows Windows PowerShell's downloads down a lot
    $repo = 'berttoli/mermdraw'
    if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
        throw "mermdraw installer: install.ps1 is for Windows; on macOS and Linux run:`n  curl -fsSL https://github.com/$repo/releases/latest/download/install.sh | sh"
    }
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($arch -notin 'AMD64', 'ARM64') {
        throw "mermdraw installer: there is no prebuilt mermdraw for $arch Windows; build it with: cargo install --git https://github.com/$repo"
    }
    $target = 'x86_64-pc-windows-msvc' # Windows on Arm runs it under emulation
    $asset = "mermdraw-$target.zip"
    $base = if ($env:MERMDRAW_INSTALL_URL) { $env:MERMDRAW_INSTALL_URL.TrimEnd('/') } else { 'https://github.com/berttoli' }
    $tag = $Version
    if ($tag -and -not $tag.StartsWith('v')) { $tag = "v$tag" }
    $url = if ($tag) { "$base/mermdraw/releases/download/$tag" } else { "$base/mermdraw/releases/latest/download" }
    $folder = if ($Dir) { $Dir } else { Join-Path $HOME '.local\bin' }
    $modifyPath = -not ($NoModifyPath -or $env:MERMDRAW_NO_MODIFY_PATH -eq '1')
    # GitHub needs TLS 1.2, which older Windows PowerShell doesn't offer by default
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('mermdraw-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $archive = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'SHA256SUMS.txt'
        try {
            Get-MermdrawDownload "$url/$asset" $archive
        } catch {
            $which = if ($tag) { $tag } else { 'latest' }
            throw "mermdraw installer: could not download $url/$asset ($($_.Exception.Message))`n  does the $which release have a build for ${target}? see https://github.com/$repo/releases"
        }
        try {
            Get-MermdrawDownload "$url/SHA256SUMS.txt" $sums
        } catch {
            throw "mermdraw installer: could not download $url/SHA256SUMS.txt ($($_.Exception.Message))"
        }

        $expected = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            $parts = $line.Trim() -split '\s+', 2
            if ($parts.Count -eq 2 -and ($parts[1] -eq $asset -or $parts[1] -eq "*$asset")) {
                $expected = $parts[0].ToLowerInvariant()
                break
            }
        }
        if (-not $expected) {
            throw "mermdraw installer: SHA256SUMS.txt does not list $asset"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "mermdraw installer: checksum mismatch for ${asset}: SHA256SUMS.txt says $expected, the download is $actual; nothing was installed"
        }
        $attestation = Test-MermdrawAttestation $archive $repo

        $unpacked = Join-Path $tmp 'unpacked'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
        $bin = Join-Path $unpacked "mermdraw-$target\mermdraw.exe"
        if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) {
            throw "mermdraw installer: $asset has no mermdraw-$target\mermdraw.exe"
        }

        try {
            New-Item -ItemType Directory -Force -Path $folder | Out-Null
        } catch {
            throw "mermdraw installer: could not create $folder; pass -Dir DIR"
        }
        $folder = (Resolve-Path -LiteralPath $folder).ProviderPath
        $exe = Join-Path $folder 'mermdraw.exe'
        $previous = ''
        if (Test-Path -LiteralPath $exe) {
            $previous = (& $exe --version 2>$null | Out-String).Trim()
        }
        # a running mermdraw.exe can't be overwritten, but it can be renamed out of the way
        $old = "$exe.old"
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
        try {
            if (Test-Path -LiteralPath $exe) { Move-Item -LiteralPath $exe -Destination $old -Force }
            Copy-Item -LiteralPath $bin -Destination $exe
        } catch {
            throw "mermdraw installer: could not write to ${folder}: $($_.Exception.Message)`n  pass -Dir DIR for another folder"
        }
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
        $installed = (& $exe --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $installed) {
            throw "mermdraw installer: installed $exe, but it doesn't run on this machine"
        }

        $sessionPath = @($env:Path -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
        if ($sessionPath -contains $folder.TrimEnd('\')) {
            $pathNote = "$folder is on your PATH"
        } elseif (-not $modifyPath) {
            $pathNote = "$folder is not on your PATH; add it in Settings > System > About > Advanced system settings > Environment Variables"
        } else {
            if (Add-MermdrawPath $folder) {
                $pathNote = "added $folder to your user PATH; open a new terminal to use it"
            } else {
                $pathNote = "$folder is already on your user PATH; open a new terminal to use it"
            }
            $env:Path = "$folder;$env:Path"
        }

        if ($previous -and $previous -ne $installed) {
            Write-Host "updated $previous -> $($installed -replace '^mermdraw ', '') at $exe"
        } else {
            Write-Host "installed $installed -> $exe"
        }
        Write-Host "  from         $url/$asset"
        Write-Host "  sha256       $actual matches SHA256SUMS.txt"
        Write-Host "  attestation  $attestation"
        Write-Host "  PATH         $pathNote"
        if ($arch -eq 'ARM64') {
            Write-Host '  note         this is the x64 build; Windows on Arm runs it under emulation'
        }
        # an older copy, from an earlier manual install for example, can come first on the PATH
        $found = Get-Command mermdraw -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found -and $found.Source -ne $exe) {
            Write-Host "  note         $($found.Source) is another mermdraw on your PATH; remove it if it's an old copy"
        }
        Write-Host "  next         mermdraw                  open the editor for the repo you're in"
        Write-Host '               mermdraw addons add mcp   let coding agents read and edit your diagrams'
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Mermdraw
