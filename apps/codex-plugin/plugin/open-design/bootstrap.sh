#!/bin/sh

# macOS compatibility entry: establish a verified Node environment before the
# TypeScript-built Codex plugin entry is allowed to run.
set -eu

fail() {
  /bin/echo "open-design codex plugin bootstrap failed: $*" >&2
  exit 1
}

script_root=$(
  CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" &&
    /bin/pwd
) || fail "cannot resolve plugin root"

identity_file="./distribution.json"
previous_arg=""
for arg in "$@"; do
  if [ "$previous_arg" = "--identity-file" ]; then
    identity_file=$arg
    break
  fi
  previous_arg=$arg
done
case "$identity_file" in
  /*) ;;
  *) identity_file="$script_root/${identity_file#./}" ;;
esac
[ -f "$identity_file" ] || fail "distribution identity is missing: $identity_file"
[ -n "${HOME:-}" ] || fail "HOME is required"

platform=$(/usr/bin/uname -s)
architecture=$(/usr/bin/uname -m)
[ "$platform" = "Darwin" ] || fail "unsupported platform: $platform"
[ "$architecture" = "arm64" ] || fail "unsupported architecture: $architecture"

json_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$2" 2>/dev/null
}

channel=$(json_value channel "$identity_file") ||
  fail "distribution channel is unreadable"
namespace=$(json_value namespace "$identity_file") ||
  fail "distribution namespace is unreadable"
case "$namespace" in
  ''|.|..|*[!A-Za-z0-9._-]*) fail "distribution namespace is invalid" ;;
esac

case "$channel" in
  stable) product_name="Open Design" ;;
  beta) product_name="Open Design Beta" ;;
  betas) product_name="Open Design Betas" ;;
  prerelease) product_name="Open Design Prerelease" ;;
  preview) product_name="Open Design Preview" ;;
  *) fail "unsupported distribution channel: $channel" ;;
esac

channel_root=${OD_DISTRIBUTION_CHANNEL_ROOT:-"$HOME/Library/Application Support/$product_name"}
case "$channel_root" in
  /*) ;;
  *) fail "OD_DISTRIBUTION_CHANNEL_ROOT must be absolute" ;;
esac
OD_DISTRIBUTION_CHANNEL_ROOT=$channel_root
export OD_DISTRIBUTION_CHANNEL_ROOT

plugin_root="$channel_root/namespaces/$namespace/codex-plugin"
environment_root="$plugin_root/environment"
state_root="$plugin_root/state"
updates_root="$plugin_root/updates/environment"
ready_path="$state_root/environment-ready.json"
lock_root="$state_root/environment.lock"
versions_root="$environment_root/node/versions"

/bin/mkdir -p "$state_root" "$updates_root" "$versions_root"
/bin/chmod 700 "$plugin_root" "$environment_root" "$state_root" \
  "$updates_root" "$versions_root" 2>/dev/null || true

node_version() {
  "$1" --version 2>/dev/null
}

node_architecture() {
  "$1" -p 'process.arch' 2>/dev/null
}

validate_node_basics() {
  candidate=$1
  expected_version=${2:-}
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  actual_architecture=$(node_architecture "$candidate") || return 1
  [ "$actual_architecture" = "arm64" ] || return 1
  actual_version=$(node_version "$candidate") || return 1
  case "$actual_version" in
    v24.*) ;;
    *) return 1 ;;
  esac
  if [ -n "$expected_version" ] && [ "$actual_version" != "$expected_version" ]; then
    return 1
  fi
  return 0
}

validate_codex_node() {
  candidate=$1
  app_root=$2
  expected="$app_root/Contents/Resources/cua_node/bin/node"
  [ "$candidate" = "$expected" ] || return 1
  validate_node_basics "$candidate" "" || return 1
  /usr/bin/codesign --verify --strict "$candidate" 2>/dev/null || return 1
  signature=$(/usr/bin/codesign -dv --verbose=4 "$candidate" 2>&1) || return 1
  /usr/bin/printf '%s\n' "$signature" |
    /usr/bin/grep -q '^TeamIdentifier=2DC432GLL2$' || return 1
  return 0
}

validate_download_url() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_sha256_digest() {
  case "$1" in
    sha256:*) ;;
    *) return 1 ;;
  esac
  digest_hex=${1#sha256:}
  [ "${#digest_hex}" -eq 64 ] || return 1
  case "$digest_hex" in
    *[!0-9a-f]*) return 1 ;;
  esac
  return 0
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print "sha256:" $1}'
}

validate_managed_node() {
  candidate=$1
  expected_version=$2
  expected_digest=$3
  validate_node_basics "$candidate" "v$expected_version" || return 1
  actual_digest=$(sha256_file "$candidate") || return 1
  [ "$actual_digest" = "$expected_digest" ]
}

write_ready() {
  source_kind=$1
  node_path=$2
  version=$3
  digest=$4
  temporary_path="$ready_path.$$"
  /usr/bin/plutil -create xml1 "$temporary_path"
  /usr/bin/plutil -insert schemaVersion -integer 1 "$temporary_path"
  /usr/bin/plutil -insert source -string "$source_kind" "$temporary_path"
  /usr/bin/plutil -insert nodePath -string "$node_path" "$temporary_path"
  /usr/bin/plutil -insert nodeVersion -string "$version" "$temporary_path"
  /usr/bin/plutil -insert nodeDigest -string "$digest" "$temporary_path"
  /usr/bin/plutil -insert platform -string "darwin-arm64" "$temporary_path"
  /usr/bin/plutil -convert json "$temporary_path"
  /bin/chmod 600 "$temporary_path"
  /bin/mv -f "$temporary_path" "$ready_path"
}

read_ready_node() {
  [ -f "$ready_path" ] || return 1
  ready_platform=$(json_value platform "$ready_path") || return 1
  [ "$ready_platform" = "darwin-arm64" ] || return 1
  ready_source=$(json_value source "$ready_path") || return 1
  ready_node=$(json_value nodePath "$ready_path") || return 1
  ready_version=$(json_value nodeVersion "$ready_path") || return 1
  ready_digest=$(json_value nodeDigest "$ready_path") || return 1
  case "$ready_source" in
    codex)
      ready_app=${OD_CODEX_PLUGIN_CODEX_APP:-/Applications/Codex.app}
      validate_codex_node "$ready_node" "$ready_app" || return 1
      ;;
    managed)
      validate_managed_node "$ready_node" "$ready_version" "$ready_digest" ||
        return 1
      ;;
    *)
      return 1
      ;;
  esac
  selected_node=$ready_node
  return 0
}

release_lock() {
  if [ "${lock_owned:-0}" = "1" ]; then
    /bin/rm -f "$lock_root/pid"
    /bin/rmdir "$lock_root" 2>/dev/null || true
  fi
}

if read_ready_node; then
  exec "$selected_node" "$script_root/mcp/server.mjs" "$@"
fi

lock_owned=0
if /bin/mkdir "$lock_root" 2>/dev/null; then
  lock_owned=1
  /usr/bin/printf '%s\n' "$$" >"$lock_root/pid"
  trap release_lock EXIT HUP INT TERM
else
  lock_pid=$(/bin/cat "$lock_root/pid" 2>/dev/null || true)
  case "$lock_pid" in
    ''|*[!0-9]*) ;;
    *)
      if ! /bin/kill -0 "$lock_pid" 2>/dev/null; then
        /bin/rm -f "$lock_root/pid"
        /bin/rmdir "$lock_root" 2>/dev/null || true
        if /bin/mkdir "$lock_root" 2>/dev/null; then
          lock_owned=1
          /usr/bin/printf '%s\n' "$$" >"$lock_root/pid"
          trap release_lock EXIT HUP INT TERM
        fi
      fi
      ;;
  esac
fi

if [ "$lock_owned" != "1" ]; then
  attempts=0
  while [ "$attempts" -lt 120 ]; do
    if read_ready_node; then
      exec "$selected_node" "$script_root/mcp/server.mjs" "$@"
    fi
    attempts=$((attempts + 1))
    /bin/sleep 0.25
  done
  fail "environment initialization is already in progress"
fi

if read_ready_node; then
  release_lock
  lock_owned=0
  trap - EXIT HUP INT TERM
  exec "$selected_node" "$script_root/mcp/server.mjs" "$@"
fi

codex_app=${OD_CODEX_PLUGIN_CODEX_APP:-/Applications/Codex.app}
codex_node="$codex_app/Contents/Resources/cua_node/bin/node"
if validate_codex_node "$codex_node" "$codex_app"; then
  codex_version=$(node_version "$codex_node")
  codex_digest=$(sha256_file "$codex_node")
  write_ready codex "$codex_node" "$codex_version" "$codex_digest"
  release_lock
  lock_owned=0
  trap - EXIT HUP INT TERM
  exec "$codex_node" "$script_root/mcp/server.mjs" "$@"
fi

manifest_url=${OD_CODEX_PLUGIN_ENVIRONMENT_MANIFEST_URL:-"https://releases.open-design.ai/codex-plugin/$channel/latest/platforms/darwin-arm64.json"}
validate_download_url "$manifest_url" ||
  fail "managed Node manifest URL must use HTTPS or loopback HTTP"
OD_CODEX_PLUGIN_ENVIRONMENT_MANIFEST_URL=$manifest_url
export OD_CODEX_PLUGIN_ENVIRONMENT_MANIFEST_URL
manifest_path="$updates_root/manifest.$$.json"
download_path="$updates_root/node.$$.download"
/usr/bin/curl --fail --location --silent --show-error \
  --connect-timeout 10 --max-time 120 \
  "$manifest_url" -o "$manifest_path" ||
  fail "managed Node manifest download failed"

manifest_platform=$(json_value platform "$manifest_path") ||
  fail "managed Node platform is unreadable"
[ "$manifest_platform" = "darwin-arm64" ] ||
  fail "managed Node platform mismatch: $manifest_platform"
manifest_schema_version=$(json_value schemaVersion "$manifest_path") ||
  fail "managed Node schema version is unreadable"
[ "$manifest_schema_version" = "1" ] ||
  fail "managed Node schema version is unsupported: $manifest_schema_version"
managed_media_type=$(json_value node.mediaType "$manifest_path") ||
  fail "managed Node media type is unreadable"
[ "$managed_media_type" = "application/vnd.open-design.node-executable-v1" ] ||
  fail "managed Node media type is unsupported: $managed_media_type"
managed_version=$(json_value node.version "$manifest_path") ||
  fail "managed Node version is unreadable"
/usr/bin/printf '%s\n' "$managed_version" |
  /usr/bin/grep -Eq '^24\.[0-9]+\.[0-9]+$' ||
  fail "managed Node version is invalid"
managed_digest=$(json_value node.digest "$manifest_path") ||
  fail "managed Node digest is unreadable"
managed_size=$(json_value node.size "$manifest_path") ||
  fail "managed Node size is unreadable"
managed_url=$(json_value node.url "$manifest_path") ||
  fail "managed Node URL is unreadable"
validate_sha256_digest "$managed_digest" ||
  fail "managed Node digest is invalid"
case "$managed_size" in
  ''|0|*[!0-9]*) fail "managed Node size is invalid" ;;
esac
validate_download_url "$managed_url" ||
  fail "managed Node URL must use HTTPS or loopback HTTP"

version_root="$versions_root/$managed_version/darwin-arm64"
managed_node="$version_root/node"
if validate_managed_node "$managed_node" "$managed_version" "$managed_digest"; then
  write_ready managed "$managed_node" "$managed_version" "$managed_digest"
  /bin/rm -f "$manifest_path"
  release_lock
  lock_owned=0
  trap - EXIT HUP INT TERM
  exec "$managed_node" "$script_root/mcp/server.mjs" "$@"
fi

/usr/bin/curl --fail --location --silent --show-error \
  --connect-timeout 10 --max-time 300 \
  "$managed_url" -o "$download_path" ||
  fail "managed Node download failed"
actual_size=$(/usr/bin/stat -f '%z' "$download_path") ||
  fail "managed Node size cannot be inspected"
[ "$actual_size" = "$managed_size" ] ||
  fail "managed Node size mismatch"
actual_digest=$(sha256_file "$download_path") ||
  fail "managed Node digest cannot be calculated"
[ "$actual_digest" = "$managed_digest" ] ||
  fail "managed Node digest mismatch"
/bin/chmod 700 "$download_path"
validate_node_basics "$download_path" "v$managed_version" ||
  fail "managed Node executable validation failed"

staging_root="$updates_root/staging.$$"
/bin/mkdir -p "$staging_root"
/bin/mv "$download_path" "$staging_root/node"
/bin/chmod 700 "$staging_root/node"
/bin/mkdir -p "$(/usr/bin/dirname "$version_root")"
if [ -e "$version_root" ]; then
  quarantine_root="$updates_root/corrupt.${managed_version}.$$"
  /bin/mv "$version_root" "$quarantine_root"
  /bin/mv "$staging_root" "$version_root"
  /bin/rm -rf "$quarantine_root"
else
  /bin/mv "$staging_root" "$version_root"
fi
validate_managed_node "$managed_node" "$managed_version" "$managed_digest" ||
  fail "activated managed Node validation failed"
write_ready managed "$managed_node" "$managed_version" "$managed_digest"
/bin/rm -f "$manifest_path"
release_lock
lock_owned=0
trap - EXIT HUP INT TERM
exec "$managed_node" "$script_root/mcp/server.mjs" "$@"
