[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string]$ArchivePath,
  [string]$HashPath = '',
  [string]$TargetVolumeName = '',
  [string]$ImageName = '',
  [switch]$KeepFailedVolume,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-TaskVolumeName {
  param(
    [Parameter(Mandatory)]
    [string]$Value
  )
  if (
    $Value.Length -gt 128 -or
    $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$'
  ) {
    throw 'TargetVolumeName must contain only letters, digits, dot, underscore, or hyphen, and must not contain slash or colon.'
  }
}

function Assert-TaskImageReference {
  param(
    [Parameter(Mandatory)]
    [string]$Value
  )
  if ($Value -cmatch '^sha256:[a-f0-9]{64}$') {
    return
  }
  $TaskImagePattern = '^(?=.{1,255}$)(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$'
  if ($Value -cnotmatch $TaskImagePattern) {
    throw 'ImageName is not a supported Docker image reference.'
  }
}

function Invoke-TaskDocker {
  param(
    [Parameter(Mandatory)]
    [string[]]$Arguments,
    [switch]$Capture
  )
  $TaskOutput = @(& docker @Arguments 2>&1)
  $TaskExitCode = $LASTEXITCODE
  if ($TaskExitCode -ne 0) {
    throw "Docker operation '$($Arguments[0])' failed with exit code $TaskExitCode."
  }
  if ($Capture) {
    return (($TaskOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
  }
}

function Test-TaskVolumeOwned {
  param(
    [Parameter(Mandatory)]
    [string]$Volume,
    [Parameter(Mandatory)]
    [string]$OperationId
  )
  try {
    $TaskInspectJson = Invoke-TaskDocker -Capture -Arguments @(
      'volume', 'inspect', $Volume
    )
  } catch {
    return $false
  }
  try {
    $TaskInspection = @($TaskInspectJson | ConvertFrom-Json -ErrorAction Stop)
    $TaskLabel = [string]$TaskInspection[0].Labels.'io.zalo-tg.restore.operation'
  } catch {
    return $false
  }
  return [string]::Equals($TaskLabel, $OperationId, [StringComparison]::Ordinal)
}

function Invoke-TaskNormalizeVolume {
  param(
    [Parameter(Mandatory)]
    [string]$Volume,
    [Parameter(Mandatory)]
    [string]$ImageId
  )
  Invoke-TaskDocker -Arguments @(
    'run', '--rm', '--network', 'none', '--user', '0:0', '--read-only',
    '--security-opt', 'no-new-privileges:true',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
    '--cap-add', 'DAC_OVERRIDE',
    '--mount', "type=volume,src=$Volume,dst=/restore",
    '--entrypoint', 'node',
    $ImageId,
    '--input-type=module', '-e',
    "import{chmodSync,chownSync,lstatSync,readdirSync}from'node:fs';import path from'node:path';const walk=p=>{const s=lstatSync(p);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw new Error('Archive contains an unsupported entry type.');chownSync(p,10001,10001);chmodSync(p,s.isDirectory()?0o700:0o600);if(s.isDirectory())for(const name of readdirSync(p))walk(path.join(p,name));};walk('/restore');"
  )
}

$TaskArchiveItem = Get-Item -LiteralPath $ArchivePath -Force
if (
  $TaskArchiveItem.PSIsContainer -or
  (($TaskArchiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
  $TaskArchiveItem.Length -le 0
) {
  throw 'ArchivePath must be a non-empty regular file, not a directory or link.'
}
$TaskArchiveFullPath = $TaskArchiveItem.FullName
$TaskArchiveName = $TaskArchiveItem.Name
if (
  $TaskArchiveName.Length -gt 240 -or
  $TaskArchiveName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*[.](?:tgz|tar[.]gz)$'
) {
  throw 'Archive filename must be a simple .tgz or .tar.gz filename.'
}

$TaskHashCandidate = if ($HashPath.Trim()) {
  $HashPath
} else {
  "$TaskArchiveFullPath.sha256"
}
$TaskHashItem = Get-Item -LiteralPath $TaskHashCandidate -Force
if (
  $TaskHashItem.PSIsContainer -or
  (($TaskHashItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
  $TaskHashItem.Length -le 0 -or
  $TaskHashItem.Length -gt 4096 -or
  $TaskHashItem.Extension -ine '.sha256'
) {
  throw 'HashPath must be a regular .sha256 file, not a directory or link.'
}

$TaskHashText = (Get-Content -LiteralPath $TaskHashItem.FullName -Raw).Trim()
$TaskHashMatch = [regex]::Match(
  $TaskHashText,
  '^(?<hash>[A-Fa-f0-9]{64})(?:[ \t]+[*]?(?<name>[A-Za-z0-9][A-Za-z0-9._-]*[.](?:tgz|tar[.]gz)))?$'
)
if (-not $TaskHashMatch.Success) {
  throw 'HashPath must contain exactly one SHA-256 value, optionally followed by the archive filename.'
}
$TaskDeclaredArchiveName = $TaskHashMatch.Groups['name'].Value
if (
  $TaskDeclaredArchiveName -and
  -not [string]::Equals(
    $TaskDeclaredArchiveName,
    $TaskArchiveName,
    [StringComparison]::Ordinal
  )
) {
  throw 'The archive filename declared by HashPath does not match ArchivePath.'
}
$TaskExpectedHash = $TaskHashMatch.Groups['hash'].Value.ToUpperInvariant()
$TaskActualHash = (Get-FileHash -LiteralPath $TaskArchiveFullPath -Algorithm SHA256).Hash.ToUpperInvariant()
if (-not [string]::Equals($TaskExpectedHash, $TaskActualHash, [StringComparison]::Ordinal)) {
  throw 'Archive SHA-256 verification failed.'
}

$TaskArchiveDirectory = $TaskArchiveItem.DirectoryName
if (-not $TaskArchiveDirectory -or $TaskArchiveDirectory -match '[,\r\n]') {
  throw 'The archive directory cannot be represented safely as a Docker bind mount.'
}

$TaskTargetVolume = if ($TargetVolumeName.Trim()) {
  $TargetVolumeName.Trim()
} else {
  $TaskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $TaskNonce = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  "zalo-tg-data-restore-$TaskStamp-$TaskNonce"
}
$TaskImageName = if ($ImageName.Trim()) {
  $ImageName.Trim()
} elseif ($env:BRIDGE_IMAGE) {
  $env:BRIDGE_IMAGE.Trim()
} else {
  'zalo-tg-bridge:local'
}
Assert-TaskVolumeName -Value $TaskTargetVolume
Assert-TaskImageReference -Value $TaskImageName

$TaskImageId = Invoke-TaskDocker -Capture -Arguments @(
  'image', 'inspect', $TaskImageName, '--format', '{{.Id}}'
)
if ($TaskImageId -notmatch '^sha256:[a-f0-9]{64}$') {
  throw 'Docker returned an invalid image ID.'
}

$TaskExistingVolumesText = Invoke-TaskDocker -Capture -Arguments @(
  'volume', 'ls', '--format', '{{.Name}}'
)
$TaskExistingVolumes = @(
  $TaskExistingVolumesText -split '[\r\n]+' | Where-Object { $_ }
)
if (
  $TaskExistingVolumes | Where-Object {
    [string]::Equals($_, $TaskTargetVolume, [StringComparison]::Ordinal)
  }
) {
  throw 'TargetVolumeName already exists; restore is allowed only into a new volume.'
}

Write-Host "Restore plan: archive=$TaskArchiveFullPath target=$TaskTargetVolume image=$TaskImageName"
Write-Host 'The script will not edit .env, start the bridge, or perform a Compose cutover.'
if ($DryRun) {
  Write-Host 'DryRun enabled; archive and Docker preflight checks passed, and no volume was created.'
  return
}

$TaskOperationId = [Guid]::NewGuid().ToString('N')
$TaskCreateAttempted = $false
$TaskVolumeOwned = $false

try {
  $TaskCreateAttempted = $true
  $TaskCreatedName = Invoke-TaskDocker -Capture -Arguments @(
    'volume', 'create',
    '--label', "io.zalo-tg.restore.operation=$TaskOperationId",
    '--label', "io.zalo-tg.restore.archive-sha256=$TaskActualHash",
    $TaskTargetVolume
  )
  if (-not [string]::Equals($TaskCreatedName, $TaskTargetVolume, [StringComparison]::Ordinal)) {
    throw 'Docker returned an unexpected volume name.'
  }
  $TaskVolumeOwned = Test-TaskVolumeOwned `
    -Volume $TaskTargetVolume `
    -OperationId $TaskOperationId
  if (-not $TaskVolumeOwned) {
    throw 'The target volume ownership label could not be verified.'
  }

  Invoke-TaskNormalizeVolume -Volume $TaskTargetVolume -ImageId $TaskImageId

  Invoke-TaskDocker -Arguments @(
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--mount', "type=volume,src=$TaskTargetVolume,dst=/restore",
    '--mount', "type=bind,src=$TaskArchiveDirectory,dst=/backup,readonly",
    '--entrypoint', 'tar',
    $TaskImageId,
    '--extract', '--gzip', '--file', "/backup/$TaskArchiveName",
    '--directory', '/restore', '--no-same-owner', '--no-same-permissions',
    '--delay-directory-restore'
  )

  $TaskHashAfterExtract = (
    Get-FileHash -LiteralPath $TaskArchiveFullPath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  if (-not [string]::Equals($TaskExpectedHash, $TaskHashAfterExtract, [StringComparison]::Ordinal)) {
    throw 'Archive changed while it was being extracted.'
  }

  Invoke-TaskNormalizeVolume -Volume $TaskTargetVolume -ImageId $TaskImageId

  Invoke-TaskDocker -Arguments @(
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--mount', "type=volume,src=$TaskTargetVolume,dst=/app/data,readonly",
    '--entrypoint', 'test',
    $TaskImageId,
    '-f', '/app/data/bridge.db'
  )

  Invoke-TaskDocker -Arguments @(
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
    '--mount', "type=volume,src=$TaskTargetVolume,dst=/app/data",
    '--env', 'DATA_DIR=/app/data', '--env', 'DATABASE_PATH=/app/data/bridge.db',
    '--entrypoint', 'node',
    $TaskImageId,
    '--input-type=module', '-e',
    "import { openBridgeDatabase, closeBridgeDatabase } from './dist/infrastructure/database/database.js'; const db = openBridgeDatabase('/app/data/bridge.db'); closeBridgeDatabase(db);"
  )

  $TaskVerifierJson = Invoke-TaskDocker -Capture -Arguments @(
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
    '--mount', "type=volume,src=$TaskTargetVolume,dst=/app/data",
    '--env', 'DATA_DIR=/app/data', '--env', 'DATABASE_PATH=/app/data/bridge.db',
    '--entrypoint', 'node',
    $TaskImageId,
    'dist/tools/verify-docker-data.js'
  )
  $TaskVerifier = $TaskVerifierJson | ConvertFrom-Json
  if (
    $TaskVerifier.quickCheck -ne 'ok' -or
    [int]$TaskVerifier.foreignKeyViolations -ne 0 -or
    [int]$TaskVerifier.invalidMultipart -ne 0 -or
    [int]$TaskVerifier.invalidManifestCounts -ne 0 -or
    [int]$TaskVerifier.invalidSkipAudits -ne 0
  ) {
    throw 'Restored data verifier reported an invalid state.'
  }

  Invoke-TaskNormalizeVolume -Volume $TaskTargetVolume -ImageId $TaskImageId

  Write-Host "Restore completed into new volume: $TaskTargetVolume"
  Write-Host (
    'Verification: quick_check=ok foreign_keys=0 topics={0} deliveries={1} ready_media={2}' -f
    [int]$TaskVerifier.topics,
    [int]$TaskVerifier.deliveries,
    [int]$TaskVerifier.readyMedia
  )
  Write-Host 'No cutover was performed. Review the volume before changing BRIDGE_DATA_VOLUME.'
} catch {
  $TaskOriginalError = $_
  if ($TaskCreateAttempted -and -not $TaskVolumeOwned) {
    $TaskVolumeOwned = Test-TaskVolumeOwned `
      -Volume $TaskTargetVolume `
      -OperationId $TaskOperationId
  }

  if ($TaskVolumeOwned) {
    if ($KeepFailedVolume) {
      Write-Warning "Restore failed; keeping script-created volume '$TaskTargetVolume' because KeepFailedVolume was set."
    } else {
      try {
        Invoke-TaskDocker -Arguments @('volume', 'rm', $TaskTargetVolume)
        Write-Warning "Restore failed; removed script-created volume '$TaskTargetVolume'."
      } catch {
        Write-Warning "Restore failed and automatic cleanup could not remove script-created volume '$TaskTargetVolume'."
      }
    }
  }
  throw $TaskOriginalError
}
