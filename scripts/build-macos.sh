#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Building the universal package requires an Apple Silicon Mac." >&2
  exit 1
fi
if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "Rosetta 2 is required to build the Intel paper engine." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build_root="${P2I_MACOS_BUILD_ROOT:-$repo_root/build/macos-universal}"
python_version="3.12.10"
python_sha256="8373e58da4ea146b3eb1c1f9834f19a319440b6b679b06050b1f9ee3237aa8e4"
python_pkg="$build_root/python-$python_version-macos11.pkg"
python_expanded="$build_root/python-$python_version-expanded"
frameworks_root="$build_root/frameworks"
python_home="$frameworks_root/Python.framework/Versions/3.12"
python_bin="$python_home/bin/python3.12"
python_app_bin="$python_home/Resources/Python.app/Contents/MacOS/Python"
engine_root="$repo_root/services/paper-engine"
output_root="$repo_root/apps/desktop/src-tauri/binaries"
macos_output="$output_root/macos"

mkdir -p "$build_root" "$frameworks_root" "$macos_output"

patch_macho_dependency() {
  local binary="$1"
  local old_path="$2"
  local new_path="$3"
  if otool -L "$binary" | grep -Fq "$old_path"; then
    install_name_tool -change "$old_path" "$new_path" "$binary"
    codesign --force --sign - "$binary"
  fi
}

if [[ ! -f "$python_pkg" ]]; then
  curl --fail --location --output "$python_pkg" \
    "https://www.python.org/ftp/python/$python_version/python-$python_version-macos11.pkg"
fi
actual_sha256="$(shasum -a 256 "$python_pkg" | awk '{print $1}')"
if [[ "$actual_sha256" != "$python_sha256" ]]; then
  echo "Python package checksum mismatch: $actual_sha256" >&2
  exit 1
fi

if [[ ! -d "$python_expanded/Python_Framework.pkg/Payload/Versions/3.12" ]]; then
  pkgutil --expand-full "$python_pkg" "$python_expanded"
fi
ln -sfn "$python_expanded/Python_Framework.pkg/Payload" \
  "$frameworks_root/Python.framework"

if [[ ! -x "$python_bin" ]]; then
  echo "Universal Python executable was not found after extraction." >&2
  exit 1
fi
patch_macho_dependency "$python_app_bin" \
  "/Library/Frameworks/Python.framework/Versions/3.12/Python" \
  "$python_home/Python"
ssl_module="$(find "$python_home/lib/python3.12/lib-dynload" -name '_ssl*.so' -print -quit)"
hashlib_module="$(find "$python_home/lib/python3.12/lib-dynload" -name '_hashlib*.so' -print -quit)"
patch_macho_dependency "$ssl_module" \
  "/Library/Frameworks/Python.framework/Versions/3.12/lib/libssl.3.dylib" \
  "$python_home/lib/libssl.3.dylib"
patch_macho_dependency "$ssl_module" \
  "/Library/Frameworks/Python.framework/Versions/3.12/lib/libcrypto.3.dylib" \
  "$python_home/lib/libcrypto.3.dylib"
patch_macho_dependency "$hashlib_module" \
  "/Library/Frameworks/Python.framework/Versions/3.12/lib/libcrypto.3.dylib" \
  "$python_home/lib/libcrypto.3.dylib"
python_arches="$(lipo -archs "$python_bin")"
if [[ "$python_arches" != *"arm64"* || "$python_arches" != *"x86_64"* ]]; then
  echo "Python must contain arm64 and x86_64 slices: $python_arches" >&2
  exit 1
fi

run_base_python() {
  local architecture="$1"
  shift
  arch "-$architecture" env \
    DYLD_FRAMEWORK_PATH="$frameworks_root" \
    DYLD_LIBRARY_PATH="$python_home/lib" \
    PYTHONHOME="$python_home" \
    SSL_CERT_FILE="${SSL_CERT_FILE:-/etc/ssl/cert.pem}" \
    "$python_bin" "$@"
}

run_venv_python() {
  local architecture="$1"
  local venv_python="$2"
  shift 2
  arch "-$architecture" env \
    DYLD_FRAMEWORK_PATH="$frameworks_root" \
    DYLD_LIBRARY_PATH="$python_home/lib" \
    SSL_CERT_FILE="${SSL_CERT_FILE:-/etc/ssl/cert.pem}" \
    "$venv_python" "$@"
}

build_engine() {
  local architecture="$1"
  local venv_root="$build_root/venv-$architecture"
  local venv_python="$venv_root/bin/python"
  local dist_root="$build_root/dist-$architecture"
  local work_root="$build_root/pyinstaller-$architecture"
  local destination="$macos_output/p2i-paper-engine-$architecture"

  if [[ ! -x "$venv_python" ]]; then
    run_base_python "$architecture" -m venv --copies "$venv_root"
  fi
  patch_macho_dependency "$venv_python" \
    "/Library/Frameworks/Python.framework/Versions/3.12/Python" \
    "$python_home/Python"
  run_venv_python "$architecture" "$venv_python" -m pip install --disable-pip-version-check \
    --upgrade "pip<27" "pyinstaller>=6.12,<7" -e "$engine_root"
  run_venv_python "$architecture" "$venv_python" -m PyInstaller \
    --noconfirm --clean --onefile \
    --name p2i-paper-engine \
    --distpath "$dist_root" \
    --workpath "$work_root" \
    --specpath "$build_root" \
    --paths "$engine_root" \
    --add-data "$engine_root/migrations:migrations" \
    --exclude-module accelerate \
    --exclude-module cv2 \
    --exclude-module docling \
    --exclude-module docling_core \
    --exclude-module docling_ibm_models \
    --exclude-module docling_parse \
    --exclude-module huggingface_hub \
    --exclude-module numpy \
    --exclude-module onnxruntime \
    --exclude-module pandas \
    --exclude-module rapidocr \
    --exclude-module safetensors \
    --exclude-module scipy \
    --exclude-module sklearn \
    --exclude-module torch \
    --exclude-module torchaudio \
    --exclude-module torchvision \
    --exclude-module transformers \
    "$repo_root/scripts/sidecar_entry.py"
  install -m 755 "$dist_root/p2i-paper-engine" "$destination"
  codesign --force --sign - "$destination"

  local response
  response="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ping"}' | \
    arch "-$architecture" "$destination" rpc | head -n 1)"
  if [[ "$response" != *'"pong":true'* ]]; then
    echo "$architecture paper engine smoke test failed: $response" >&2
    exit 1
  fi
}

build_engine arm64
build_engine x86_64

launcher_arm64="$build_root/p2i-paper-engine-launcher-arm64"
launcher_x86_64="$build_root/p2i-paper-engine-launcher-x86_64"
launcher_universal="$output_root/p2i-paper-engine-universal-apple-darwin"
launcher_target_arm64="$output_root/p2i-paper-engine-aarch64-apple-darwin"
launcher_target_x86_64="$output_root/p2i-paper-engine-x86_64-apple-darwin"
xcrun clang -Os -Wall -Wextra -Werror -mmacosx-version-min=11.0 -arch arm64 \
  "$repo_root/scripts/macos-sidecar-launcher.c" -o "$launcher_arm64"
xcrun clang -Os -Wall -Wextra -Werror -mmacosx-version-min=11.0 -arch x86_64 \
  "$repo_root/scripts/macos-sidecar-launcher.c" -o "$launcher_x86_64"
install -m 755 "$launcher_arm64" "$launcher_target_arm64"
install -m 755 "$launcher_x86_64" "$launcher_target_x86_64"
lipo -create "$launcher_arm64" "$launcher_x86_64" -output "$launcher_universal"
chmod 755 "$launcher_universal"
codesign --force --sign - "$launcher_target_arm64"
codesign --force --sign - "$launcher_target_x86_64"
codesign --force --sign - "$launcher_universal"

if [[ ! -f "$repo_root/apps/desktop/src-tauri/icons/icon.png" || \
      ! -f "$repo_root/apps/desktop/src-tauri/icons/icon.icns" ]]; then
  run_venv_python arm64 "$build_root/venv-arm64/bin/python" \
    "$repo_root/scripts/generate_icons.py" --macos-only
fi

if [[ "${1:-}" == "--sidecar-only" ]]; then
  echo "Universal macOS sidecar prepared at $launcher_universal"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi
rustup_bin="$(command -v rustup || true)"
if [[ -z "$rustup_bin" && -x "$HOME/.cargo/bin/rustup" ]]; then
  rustup_bin="$HOME/.cargo/bin/rustup"
fi
if [[ -z "$rustup_bin" ]]; then
  echo "Rustup is required. Install Rust from https://rustup.rs first." >&2
  exit 1
fi

"$rustup_bin" target add aarch64-apple-darwin x86_64-apple-darwin
cd "$repo_root"
npm ci
npm run tauri --workspace @p2i/desktop -- build \
  --target universal-apple-darwin \
  --bundles app,dmg \
  --config src-tauri/tauri.macos-universal.conf.json

echo "Universal macOS bundles:"
find "$repo_root/apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle" \
  -maxdepth 2 -type f \( -name '*.dmg' -o -name '*.app.tar.gz' \) -print
