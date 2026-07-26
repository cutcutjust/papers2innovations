param(
  [Parameter(Mandatory = $false)]
  [string]$TargetTriple = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$EngineRoot = Join-Path $RepoRoot "services/paper-engine"
$OutputRoot = Join-Path $RepoRoot "apps/desktop/src-tauri/binaries"
$WindowsVirtualenvPython = Join-Path $RepoRoot ".venv/Scripts/python.exe"
$UnixVirtualenvPython = Join-Path $RepoRoot ".venv/bin/python"
$Python = if (Test-Path $WindowsVirtualenvPython) {
  $WindowsVirtualenvPython
} elseif (Test-Path $UnixVirtualenvPython) {
  $UnixVirtualenvPython
} else {
  "python"
}
$DistRoot = Join-Path $RepoRoot "dist"
$BuildRoot = Join-Path $RepoRoot "build"
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

if (-not $TargetTriple) {
  $HostLine = rustc -vV | Select-String '^host:' | Select-Object -First 1
  if (-not $HostLine) { throw "Unable to determine the Rust host target" }
  $TargetTriple = ($HostLine.Line -replace '^host:\s*', '').Trim()
}

& $Python -m pip install -e "${EngineRoot}[docling]" pyinstaller
& $Python -m PyInstaller --noconfirm --clean --onefile --name p2i-paper-engine `
  --collect-all docling --collect-all docling_core `
  --distpath $DistRoot --workpath $BuildRoot --specpath $RepoRoot `
  --paths $EngineRoot (Join-Path $PSScriptRoot "sidecar_entry.py")

$Extension = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }
$Source = Join-Path $DistRoot "p2i-paper-engine$Extension"
$Destination = Join-Path $OutputRoot "p2i-paper-engine-$TargetTriple$Extension"
Copy-Item -Force $Source $Destination
Write-Output $Destination
