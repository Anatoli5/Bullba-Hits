# Bullba Hits - the installer as a script. Install.cmd hands this file to Windows' own powershell.exe,
# so no executable of ours runs and application control has nothing of ours to block.
# The checks mirror the [Code] section of installer\ArmorInspector.iss (CheckGame, GameRunning,
# IsKnownLegacyMod, BackupLegacyMod, BackupViewerFiles, CheckOwnedFile); what is missing on purpose is
# the registry entry, the uninstaller and the desktop shortcut.
# Cmdlets only - no Add-Type, no COM, no static .NET calls - so it also runs in Constrained Language Mode.
param([Parameter(Position = 0)][string] $GameFolder = '')

$ErrorActionPreference = 'Stop'

$script:Log = @()
$script:Wrote = $false

function Note {
    param([string] $Text)
    $script:Log += ((Get-Date -Format 'HH:mm:ss') + '  ' + $Text)
}

function Get-Sha256 {
    param([string] $Path)
    $result = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $result.Hash
}

$written = 0
$kept = 0
$moved = 0
$viewerBackup = ''
$logPath = ''

try {
    $root = $PSScriptRoot
    if (-not $root) { throw 'Run Install.cmd from the unpacked folder.' }
    $manifestPath = Join-Path $root 'manifest.json'
    $payloadRoot = Join-Path $root 'payload'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'manifest.json is missing beside install.ps1.' }
    if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) { throw 'The payload folder is missing beside install.ps1.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $files = @($manifest.files)
    if ($files.Count -lt 1) { throw 'manifest.json lists no files.' }

    # 1. The game folder: the argument, the usual path, or asked for.
    $default = $manifest.defaultGameFolder
    if (-not $default) { $default = 'C:\Games\World_of_Tanks_NA' }
    $game = $GameFolder
    if (-not $game) {
        if (Test-Path -LiteralPath $default -PathType Container) { $game = $default }
        else { $game = Read-Host 'Path to the World of Tanks folder' }
    }
    $game = $game.Trim()
    $game = $game.Trim('"')
    $game = $game.TrimEnd('\')
    if (-not $game) { throw 'No game folder was given.' }
    if (-not (Test-Path -LiteralPath $game -PathType Container)) { throw ('There is no such folder: ' + $game) }

    # 2. It must be a World of Tanks root of the client this build is made for.
    $versionXml = Join-Path $game 'version.xml'
    if (-not (Test-Path -LiteralPath $versionXml -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $game 'res\packages') -PathType Container)) {
        throw 'Select the World of Tanks root folder: version.xml and res\packages.'
    }
    $versionNode = Select-Xml -LiteralPath $versionXml -XPath '/version.xml/version' -ErrorAction SilentlyContinue
    $realmNode = Select-Xml -LiteralPath $versionXml -XPath '/version.xml/meta/realm' -ErrorAction SilentlyContinue
    if (-not $versionNode -or -not $realmNode) { throw 'Could not read version.xml of the selected game.' }
    $clientVersion = $versionNode.Node.InnerText.Trim()
    $clientRealm = $realmNode.Node.InnerText.Trim()
    if (($clientVersion -cne $manifest.client) -or ($clientRealm -cne $manifest.realm)) {
        throw ('This build is for WoT PC ' + $manifest.realm + ' ' + $manifest.client +
            '; the selected folder has ' + $clientRealm + ' ' + $clientVersion + '.')
    }

    # 3. The game must be closed. Nothing is ever closed for the user.
    if (Get-Process -Name 'WorldOfTanks' -ErrorAction SilentlyContinue) {
        throw 'Close World of Tanks before installing. The installer does not close the game itself.'
    }

    # 4. Every build of our recorder is local.armor_inspector_<x.y.z>.wotmod. Anything else under that
    #    name is not ours to move aside.
    $modsFolder = Join-Path $game 'mods\2.4.0.1'
    $ourName = '^local\.armor_inspector_(\d+\.\d+\.\d+)\.wotmod$'
    if (Test-Path -LiteralPath $modsFolder -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $modsFolder -File) {
            if (-not ($file.Name -like 'local.armor_inspector*.wotmod')) { continue }
            if ($file.Name -notmatch $ourName) {
                throw ('A different version of our recorder is installed, remove it first: ' + $file.FullName)
            }
        }
    }

    # 5. Our own .wotmod under this version number is never rebuilt, so a different file with that
    #    name is somebody else's and is not replaced (CheckOwnedFile).
    $modEntry = $null
    foreach ($entry in $files) { if ($entry.path -eq ('mods\2.4.0.1\' + $manifest.mod)) { $modEntry = $entry } }
    if (-not $modEntry) { throw 'manifest.json does not carry our own .wotmod.' }
    $modDest = Join-Path $game $modEntry.path
    if (Test-Path -LiteralPath $modDest -PathType Leaf) {
        if ((Get-Sha256 $modDest) -ne $modEntry.sha256) {
            throw ('The target folder already contains a different file. It will not be replaced: ' + $modDest)
        }
    }

    # 6. The package itself must be complete and unchanged.
    foreach ($entry in $files) {
        $source = Join-Path $payloadRoot $entry.path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('The package is incomplete: payload\' + $entry.path) }
        if ((Get-Sha256 $source) -ne $entry.sha256) { throw ('A file of the package does not match its hash: payload\' + $entry.path) }
    }

    # 7. Battle records, extracted models and other mods are hashed now and verified again at the end.
    $configRoot = Join-Path $game 'mods\configs\local.armor_inspector'
    $guard = @{}
    foreach ($folder in @('battles', 'data')) {
        $dir = Join-Path $configRoot $folder
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $dir -File -Recurse) {
            $guard[$file.FullName] = (Get-Sha256 $file.FullName)
        }
    }
    if (Test-Path -LiteralPath $modsFolder -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $modsFolder -File) {
            if (-not ($file.Name -like '*.wotmod')) { continue }
            if ($file.Name -like 'local.armor_inspector*') { continue }
            $guard[$file.FullName] = (Get-Sha256 $file.FullName)
        }
    }

    # Every check has passed; writing starts here.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupRoot = Join-Path $configRoot 'installer\backups'
    Note ('Bullba Hits ' + $manifest.version + ' - script installer')
    Note ('Game folder: ' + $game)
    Note ('Client: ' + $clientRealm + ' ' + $clientVersion)
    Note ('Files kept and verified afterwards: ' + $guard.Count)

    # 8. The viewer files of the previous build go to a time-stamped backup (BackupViewerFiles).
    $viewer = Join-Path $configRoot 'Viewer.html'
    if (Test-Path -LiteralPath $viewer -PathType Leaf) {
        $viewerBackup = Join-Path $backupRoot ('viewer-' + $stamp)
        New-Item -ItemType Directory -Path $viewerBackup -Force | Out-Null
        $script:Wrote = $true
        Copy-Item -LiteralPath $viewer -Destination (Join-Path $viewerBackup 'Viewer.html') -Force
        foreach ($sub in @('web', 'web\vendor')) {
            $from = Join-Path $configRoot $sub
            if (-not (Test-Path -LiteralPath $from -PathType Container)) { continue }
            $found = @(Get-ChildItem -LiteralPath $from -File)
            if ($found.Count -lt 1) { continue }
            $to = Join-Path $viewerBackup $sub
            New-Item -ItemType Directory -Path $to -Force | Out-Null
            foreach ($file in $found) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $to $file.Name) -Force }
        }
        Note ('viewer backup: ' + $viewerBackup)
    }

    # 9. The payload. A file that is only seeded (the panel mods, the empty history index) is never
    #    replaced; the rest is written through a temporary name and moved over the destination.
    foreach ($entry in $files) {
        $source = Join-Path $payloadRoot $entry.path
        $dest = Join-Path $game $entry.path
        if ($entry.onlyIfAbsent -and (Test-Path -LiteralPath $dest)) {
            $kept = $kept + 1
            Note ('kept   ' + $entry.path)
            continue
        }
        $dir = Split-Path -Path $dest -Parent
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $tmp = $dest + '.bullba-tmp'
        Copy-Item -LiteralPath $source -Destination $tmp -Force
        $script:Wrote = $true
        Move-Item -LiteralPath $tmp -Destination $dest -Force
        $written = $written + 1
        Note ('wrote  ' + $entry.path)
    }
    foreach ($entry in $files) {
        if ($entry.onlyIfAbsent) { continue }
        if ((Get-Sha256 (Join-Path $game $entry.path)) -ne $entry.sha256) {
            throw ('The installed file differs from the package: ' + $entry.path)
        }
    }

    # 10. Any earlier build of ours, in this client's folder and in the previous one, is moved to the
    #     backups - never deleted. A different file under the same version number keeps its own folder.
    foreach ($folder in @('2.4.0.1', '2.4.0.0')) {
        $dir = Join-Path $game ('mods\' + $folder)
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $dir -File) {
            if ($file.Name -eq $manifest.mod) { continue }
            if (-not ($file.Name -match $ourName)) { continue }
            $old = $Matches[1]
            $hash = Get-Sha256 $file.FullName
            $target = Join-Path (Join-Path $backupRoot $old) $file.Name
            if ((Test-Path -LiteralPath $target -PathType Leaf) -and ((Get-Sha256 $target) -ne $hash)) {
                $target = Join-Path (Join-Path $backupRoot ($old + '-' + $hash.Substring(0, 8).ToLower())) $file.Name
            }
            if ((Test-Path -LiteralPath $target -PathType Leaf) -and ((Get-Sha256 $target) -ne $hash)) {
                $target = Join-Path (Join-Path $backupRoot ($old + '-' + $hash.ToLower())) $file.Name
            }
            $targetDir = Split-Path -Path $target -Parent
            if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
            Move-Item -LiteralPath $file.FullName -Destination $target -Force
            $moved = $moved + 1
            Note ('moved  ' + $file.FullName + ' -> ' + $target)
        }
    }

    # 11. Nothing of the user's changed, and one recorder is active.
    foreach ($path in $guard.Keys) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('A file that had to be kept is gone: ' + $path) }
        if ((Get-Sha256 $path) -ne $guard[$path]) { throw ('A file that had to be kept changed: ' + $path) }
    }
    $active = @(Get-ChildItem -LiteralPath $modsFolder -File | Where-Object { $_.Name -like 'local.armor_inspector_*.wotmod' })
    if ($active.Count -ne 1) { throw ('mods\2.4.0.1 must hold exactly one recorder; it holds ' + $active.Count + '.') }
    Note ('active recorder: ' + $active[0].FullName)
    Note ('written ' + $written + ', kept ' + $kept + ', moved to backups ' + $moved)

    $logDir = Join-Path $configRoot 'installer'
    if (-not (Test-Path -LiteralPath $logDir -PathType Container)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $logPath = Join-Path $logDir ('script-install-' + $stamp + '.log')
    Set-Content -LiteralPath $logPath -Value $script:Log -Encoding UTF8

    Write-Host ''
    Write-Host ('Bullba Hits ' + $manifest.version + ' is installed in ' + $game)
    Write-Host ('  written ' + $written + ', kept ' + $kept + ', earlier recorders moved to backups ' + $moved)
    Write-Host ('  records, models and other mods verified unchanged: ' + $guard.Count + ' files')
    if ($viewerBackup) { Write-Host ('  previous viewer files: ' + $viewerBackup) }
    Write-Host ('  log: ' + $logPath)
    Write-Host ('  the viewer is ' + (Join-Path $configRoot 'Viewer.html') + ' - open it in a browser')
    exit 0
}
catch {
    $reason = $_.Exception.Message
    Write-Host ''
    if ($script:Wrote) { Write-Host ('Install failed after files were written: ' + $reason) }
    else { Write-Host ('Refused, nothing was changed: ' + $reason) }
    exit 1
}
