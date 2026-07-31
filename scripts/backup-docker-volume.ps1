[CmdletBinding()]
param(
  [string]$VolumeName = '',
  [string]$ImageName = '',
  [string]$OutputDirectory = 'backups',
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 30,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-TaskVolumeName {
  param(
    [Parameter(Mandatory)]
    [string]$Value
  )
  if ($Value.Length -gt 255 -or $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
    throw 'VolumeName must start with an alphanumeric character and contain only alphanumerics, underscore, period, or hyphen.'
  }
}

function Assert-TaskImageName {
  param(
    [Parameter(Mandatory)]
    [string]$Value
  )
  if ($Value.Length -gt 255 -or $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$') {
    throw 'ImageName contains unsupported characters.'
  }
}

function Invoke-TaskDocker {
  param(
    [Parameter(Mandatory)]
    [string[]]$Arguments,
    [switch]$Capture
  )
  $TaskOutput = & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
  if ($Capture) {
    return ($TaskOutput -join [Environment]::NewLine).Trim()
  }
  $TaskOutput | ForEach-Object { Write-Host $_ }
}

$TaskRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskVolumeName = if ($VolumeName.Trim()) {
  $VolumeName.Trim()
} elseif ($env:BRIDGE_DATA_VOLUME) {
  $env:BRIDGE_DATA_VOLUME.Trim()
} else {
  'zalo-tg-data'
}
$TaskImageName = if ($ImageName.Trim()) {
  $ImageName.Trim()
} elseif ($env:BRIDGE_IMAGE) {
  $env:BRIDGE_IMAGE.Trim()
} else {
  'zalo-tg-bridge:local'
}
Assert-TaskVolumeName -Value $TaskVolumeName
Assert-TaskImageName -Value $TaskImageName

$TaskOutputCandidate = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $TaskRepoRoot $OutputDirectory
}
if (-not $DryRun) {
  [void](New-Item -ItemType Directory -Path $TaskOutputCandidate -Force)
}
$TaskOutputPath = if (Test-Path -LiteralPath $TaskOutputCandidate) {
  (Resolve-Path -LiteralPath $TaskOutputCandidate).Path
} else {
  [IO.Path]::GetFullPath($TaskOutputCandidate)
}

[void](Invoke-TaskDocker -Capture -Arguments @('volume', 'inspect', $TaskVolumeName))
[void](Invoke-TaskDocker -Capture -Arguments @('image', 'inspect', $TaskImageName))

$TaskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$TaskArchiveName = "$TaskVolumeName-$TaskStamp.tgz"
$TaskPartialName = "$TaskArchiveName.partial"
$TaskArchivePath = Join-Path $TaskOutputPath $TaskArchiveName
$TaskPartialPath = Join-Path $TaskOutputPath $TaskPartialName
$TaskHashPath = "$TaskArchivePath.sha256"
$TaskManifestPath = "$TaskArchivePath.manifest.json"
$TaskWasRunning = $false
$TaskStoppedByScript = $false

$TaskComposeContainer = Invoke-TaskDocker -Capture -Arguments @(
  'compose', 'ps', '--status', 'running', '-q', 'bridge'
)
$TaskVolumeUsersText = Invoke-TaskDocker -Capture -Arguments @(
  'ps', '--no-trunc', '--filter', "volume=$TaskVolumeName", '--format', '{{.ID}}'
)
$TaskVolumeUsers = @(
  $TaskVolumeUsersText -split '\r?\n' |
    Where-Object { $_.Trim() } |
    ForEach-Object { $_.Trim() }
)
if ($TaskVolumeUsers.Count -gt 0) {
  if (-not $TaskComposeContainer.Trim() -or
      $TaskVolumeUsers.Count -ne 1 -or
      $TaskVolumeUsers[0] -ne $TaskComposeContainer.Trim()) {
    throw "Volume $TaskVolumeName is mounted by a running container other than the current Compose bridge; refusing an inconsistent backup."
  }
  $TaskWasRunning = $true
}

Write-Host "Backup plan: volume=$TaskVolumeName image=$TaskImageName output=$TaskArchivePath"
Write-Host "Bridge running before backup: $TaskWasRunning"
if ($DryRun) {
  Write-Host 'DryRun enabled; no container, volume, archive, hash, manifest, or retention state was changed.'
  exit 0
}

try {
  if ($TaskWasRunning) {
    Invoke-TaskDocker -Arguments @('compose', 'stop', '--timeout', '180', 'bridge')
    $TaskStoppedByScript = $true
  }

  $TaskVerificationJson = Invoke-TaskDocker -Capture -Arguments @(
    'run', '--rm', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
    '--mount', "type=volume,src=$TaskVolumeName,dst=/source,readonly",
    '--entrypoint', 'node',
    $TaskImageName,
    '--input-type=module',
    '-e',
    "import Database from 'better-sqlite3';import{copyFileSync,existsSync}from'node:fs';for(const suffix of['','-wal','-shm']){const source='/source/bridge.db'+suffix;if(existsSync(source))copyFileSync(source,'/tmp/bridge.db'+suffix)}const db=new Database('/tmp/bridge.db',{readonly:true,fileMustExist:true});const quick=db.pragma('quick_check');const foreign=db.pragma('foreign_key_check');const migration=db.prepare('SELECT coalesce(max(version),0) AS version FROM schema_migrations').get();console.log(JSON.stringify({quickCheck:quick[0]?.quick_check??'',foreignKeyViolations:foreign.length,schemaVersion:Number(migration.version)}));db.close();"
  )
  $TaskVerification = $TaskVerificationJson | ConvertFrom-Json
  if ($TaskVerification.quickCheck -ne 'ok' -or $TaskVerification.foreignKeyViolations -ne 0) {
    throw 'SQLite verification failed before backup.'
  }

  Invoke-TaskDocker -Arguments @(
    'run', '--rm', '--network', 'none', '--user', '0:0', '--read-only',
    '--mount', "type=volume,src=$TaskVolumeName,dst=/source,readonly",
    '--mount', "type=bind,src=$TaskOutputPath,dst=/backup",
    '--entrypoint', 'tar',
    $TaskImageName,
    '-C', '/source', '-czf', "/backup/$TaskPartialName", '.'
  )
  if (-not (Test-Path -LiteralPath $TaskPartialPath)) {
    throw 'Docker reported success but the partial archive is missing.'
  }
  Move-Item -LiteralPath $TaskPartialPath -Destination $TaskArchivePath

  $TaskArchive = Get-Item -LiteralPath $TaskArchivePath
  $TaskHash = (Get-FileHash -LiteralPath $TaskArchivePath -Algorithm SHA256).Hash.ToUpperInvariant()
  $TaskUtf8NoBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText(
    $TaskHashPath,
    "$TaskHash  $TaskArchiveName$([Environment]::NewLine)",
    $TaskUtf8NoBom
  )
  $TaskImageId = Invoke-TaskDocker -Capture -Arguments @(
    'image', 'inspect', $TaskImageName, '--format', '{{.Id}}'
  )
  $TaskManifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    sourceVolume = $TaskVolumeName
    image = $TaskImageName
    imageId = $TaskImageId
    archive = $TaskArchiveName
    archiveBytes = $TaskArchive.Length
    sha256 = $TaskHash
    sqlite = $TaskVerification
    containsCredentials = $true
  }
  [IO.File]::WriteAllText(
    $TaskManifestPath,
    ($TaskManifest | ConvertTo-Json -Depth 5),
    $TaskUtf8NoBom
  )

  $TaskCutoff = (Get-Date).AddDays(-$RetentionDays)
  $TaskNamePattern = '^' + [regex]::Escape($TaskVolumeName) +
    '-[0-9]{8}-[0-9]{6}[.]tgz([.]sha256|[.]manifest[.]json)?$'
  Get-ChildItem -LiteralPath $TaskOutputPath -File |
    Where-Object {
      $_.Name -match $TaskNamePattern -and
      $_.LastWriteTime -lt $TaskCutoff -and
      $_.FullName -ne $TaskArchivePath -and
      $_.FullName -ne $TaskHashPath -and
      $_.FullName -ne $TaskManifestPath
    } |
    ForEach-Object {
      Write-Host "Deleting expired backup artifact: $($_.FullName)"
      Remove-Item -LiteralPath $_.FullName -Force
    }

  Write-Host "Backup completed: $TaskArchivePath"
  Write-Host "SHA-256: $TaskHash"
  Write-Host "Manifest: $TaskManifestPath"
} finally {
  if (Test-Path -LiteralPath $TaskPartialPath) {
    Remove-Item -LiteralPath $TaskPartialPath -Force
  }
  if ($TaskWasRunning -and $TaskStoppedByScript) {
    Invoke-TaskDocker -Arguments @('compose', 'up', '-d', '--no-build', 'bridge')
  }
}
