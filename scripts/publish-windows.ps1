param(
  [Parameter(Mandatory = $false)]
  [string]$Version = "",
  [Parameter(Mandatory = $false)]
  [string]$ReleaseRepo = "cutcutjust/papers2innovations",
  [Parameter(Mandatory = $false)]
  [string]$SigningKeyPath = "$env:LOCALAPPDATA/P2I/updater/papers2innovations.key",
  [Parameter(Mandatory = $false)]
  [string]$SigningPasswordPath = "$env:LOCALAPPDATA/P2I/updater/signing-password.dpapi",
  [Parameter(Mandatory = $false)]
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TauriConfigPath = Join-Path $RepoRoot "apps/desktop/src-tauri/tauri.conf.json"
$TauriConfig = Get-Content -Raw $TauriConfigPath | ConvertFrom-Json
if (-not $Version) { $Version = $TauriConfig.version }
if (-not (Test-Path -LiteralPath $SigningKeyPath -PathType Leaf)) {
  throw "Updater signing key not found: $SigningKeyPath"
}
if (-not (Test-Path -LiteralPath $SigningPasswordPath -PathType Leaf)) {
  throw "Updater signing password not found: $SigningPasswordPath"
}

$Gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $Gh) {
  $BundledGh = "$env:LOCALAPPDATA/Programs/GitHub CLI 2.96.0/bin/gh.exe"
  if (-not (Test-Path -LiteralPath $BundledGh)) { throw "GitHub CLI is not installed" }
  $Gh = Get-Item $BundledGh
}
$GhPath = if ($Gh.Source) { $Gh.Source } else { $Gh.FullName }

if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build-sidecar.ps1") -Flavor core
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $SigningKeyPath
  Add-Type -AssemblyName System.Security
  $ProtectedPassword = [System.IO.File]::ReadAllBytes($SigningPasswordPath)
  $PasswordBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $ProtectedPassword,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Text.Encoding]::UTF8.GetString($PasswordBytes)
  Push-Location $RepoRoot
  try {
    npm run tauri build --workspace @p2i/desktop
  } finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    Pop-Location
  }
}

$BundleRoot = Join-Path $RepoRoot "apps/desktop/src-tauri/target/release/bundle/nsis"
$Installer = Join-Path $BundleRoot "Papers2Innovations_${Version}_x64-setup.exe"
$Signature = "$Installer.sig"
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Installer not found: $Installer" }
if (-not (Test-Path -LiteralPath $Signature -PathType Leaf)) { throw "Updater signature not found: $Signature" }

$Tag = "v$Version"
$ReleaseTarget = (& git -C $RepoRoot rev-parse HEAD).Trim()
if (-not $ReleaseTarget) { throw "Cannot resolve the release source commit" }
$FileName = Split-Path -Leaf $Installer
$DownloadUrl = "https://github.com/$ReleaseRepo/releases/download/$Tag/$FileName"
$Manifest = [ordered]@{
  version = $Version
  notes = "PDF import now uses high-quality visual reconstruction as the single supported workflow. A Windows stack overflow in the file hashing path has been fixed by moving the import buffer off the Tauri worker stack, and copied PDFs are registered once through a dedicated background queue instead of triggering overlapping full-library scans. The paper library now supports complete create, read, update, and delete workflows: users can edit verified metadata with reparse-safe manual overrides, or safely remove P2I-managed PDFs and related reading data without touching Zotero or files outside the library. Existing libraries, model settings, prompts, credentials, translations, and conversations remain compatible across the upgrade."
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content -Raw -LiteralPath $Signature).Trim()
      url = $DownloadUrl
    }
  }
}
$ReleaseRoot = Join-Path $RepoRoot ".p2i-release"
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
$ManifestPath = Join-Path $ReleaseRoot "latest.json"
$Json = $Manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($ManifestPath, $Json, [System.Text.UTF8Encoding]::new($false))

$ReleaseExists = $false
try {
  & $GhPath release view $Tag --repo $ReleaseRepo *> $null
  $ReleaseExists = $LASTEXITCODE -eq 0
} catch {
  $ReleaseExists = $false
}
if ($ReleaseExists) {
  & $GhPath release upload $Tag $Installer $Signature $ManifestPath --repo $ReleaseRepo --clobber
} else {
  & $GhPath release create $Tag $Installer $Signature $ManifestPath --repo $ReleaseRepo `
    --target $ReleaseTarget `
    --title "Papers2Innovations $Version - Windows x64" `
    --notes $Manifest.notes
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $GhPath release view $Tag --repo $ReleaseRepo --json url,assets
