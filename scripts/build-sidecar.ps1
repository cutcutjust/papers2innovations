param(
  [Parameter(Mandatory = $false)]
  [string]$TargetTriple = "",
  [Parameter(Mandatory = $false)]
  [ValidateSet("core", "full")]
  [string]$Flavor = "core"
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
$MigrationsRoot = Join-Path $EngineRoot "migrations"
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

if (-not $TargetTriple) {
  $HostLine = rustc -vV | Select-String '^host:' | Select-Object -First 1
  if (-not $HostLine) { throw "Unable to determine the Rust host target" }
  $TargetTriple = ($HostLine.Line -replace '^host:\s*', '').Trim()
}

$EnginePackage = if ($Flavor -eq "full") { "${EngineRoot}[docling]" } else { $EngineRoot }
& $Python -m pip install -e $EnginePackage pyinstaller

$PyInstallerArgs = @(
  "--noconfirm", "--clean", "--onefile",
  "--name", "p2i-paper-engine",
  "--distpath", $DistRoot,
  "--workpath", $BuildRoot,
  "--specpath", $RepoRoot,
  "--paths", $EngineRoot,
  "--add-data", "$MigrationsRoot$([IO.Path]::PathSeparator)migrations"
)
if ($Flavor -eq "full") {
  $PyInstallerArgs += @("--collect-all", "docling", "--collect-all", "docling_core")
} else {
  $OptionalModules = @(
    "accelerate", "cv2", "docling", "docling_core", "docling_ibm_models",
    "docling_parse", "huggingface_hub", "numpy", "onnxruntime", "pandas",
    "rapidocr", "safetensors", "scipy", "sklearn", "torch", "torchaudio",
    "torchvision", "transformers"
  )
  foreach ($Module in $OptionalModules) {
    $PyInstallerArgs += @("--exclude-module", $Module)
  }
}
$PyInstallerArgs += (Join-Path $PSScriptRoot "sidecar_entry.py")
& $Python -m PyInstaller @PyInstallerArgs

$Extension = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }
$Source = Join-Path $DistRoot "p2i-paper-engine$Extension"
$Destination = Join-Path $OutputRoot "p2i-paper-engine-$TargetTriple$Extension"
Copy-Item -Force $Source $Destination
Write-Output "$Destination ($Flavor)"
