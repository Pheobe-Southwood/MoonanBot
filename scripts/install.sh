#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_VERSION="v0.0.1-rc.4"
ASSET=""
UNINSTALL=0
PURGE=0
REPOSITORY="Pheobe-Southwood/MoonanBot"
APP_ROOT="/opt/moonanbot"
DATA_ROOT="/var/lib/moonanbot"
CONFIG_ROOT="/etc/moonanbot"
SERVICE_FILE="/etc/systemd/system/moonanbot.service"

while (($#)); do
  case "$1" in
    --version) RELEASE_VERSION="${2:?missing version}"; shift 2 ;;
    --asset) ASSET="${2:?missing asset path}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "MoonanBot installer must run as root." >&2; exit 1; fi
if [[ ! "$RELEASE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]]; then echo "Invalid version: $RELEASE_VERSION" >&2; exit 2; fi

if ((UNINSTALL)); then
  systemctl disable --now moonanbot.service 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  rm -rf "$APP_ROOT"
  if ((PURGE)); then
    rm -rf "$DATA_ROOT" "$CONFIG_ROOT"
    userdel moonanbot 2>/dev/null || true
    echo "MoonanBot was removed, including data and configuration. This cannot be recovered without a backup."
  else
    echo "MoonanBot was removed. Data in $DATA_ROOT and configuration in $CONFIG_ROOT were preserved."
  fi
  exit 0
fi

source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "26.04" ]]; then echo "This installer requires Ubuntu 26.04." >&2; exit 1; fi
if [[ "$(uname -m)" != "x86_64" ]]; then echo "This installer requires x86_64." >&2; exit 1; fi
if [[ "$(ps -p 1 -o comm=)" != "systemd" ]]; then echo "This installer requires systemd." >&2; exit 1; fi

install -d -m 0755 "$APP_ROOT" "$APP_ROOT/releases" "$APP_ROOT/runtime/bin"
install -d -m 0700 "$DATA_ROOT" "$DATA_ROOT/backups" "$CONFIG_ROOT"
if ! id moonanbot >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin --user-group moonanbot
fi
chown -R moonanbot:moonanbot "$DATA_ROOT"

node_compatible() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=19) ? 0 : 1)' >/dev/null 2>&1
}

SYSTEM_NODE="$(command -v node || true)"
if [[ -n "$SYSTEM_NODE" ]] && node_compatible "$SYSTEM_NODE"; then
  ln -sfn "$(readlink -f "$SYSTEM_NODE")" "$APP_ROOT/runtime/bin/node"
else
  NODE_VERSION="22.22.1"
  TEMP_RUNTIME="$(mktemp -d)"
  trap 'rm -rf "$TEMP_RUNTIME"' EXIT
  NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$TEMP_RUNTIME/$NODE_ARCHIVE"
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$TEMP_RUNTIME/SHASUMS256.txt"
  (cd "$TEMP_RUNTIME" && grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum --check --strict)
  rm -rf "$APP_ROOT/runtime/node-v${NODE_VERSION}"
  tar -xJf "$TEMP_RUNTIME/$NODE_ARCHIVE" -C "$APP_ROOT/runtime"
  ln -sfn "$APP_ROOT/runtime/node-v${NODE_VERSION}-linux-x64/bin/node" "$APP_ROOT/runtime/bin/node"
fi

TEMP_ASSET=""
if [[ -z "$ASSET" ]]; then
  TEMP_ASSET="$(mktemp -d)"
  trap 'rm -rf "$TEMP_ASSET"' EXIT
  ASSET="$TEMP_ASSET/MoonanBot-linux-x64-${RELEASE_VERSION}.tar.gz"
  curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/${REPOSITORY}/releases/download/${RELEASE_VERSION}/MoonanBot-linux-x64-${RELEASE_VERSION}.tar.gz" -o "$ASSET"
  curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/${REPOSITORY}/releases/download/${RELEASE_VERSION}/SHA256SUMS" -o "$TEMP_ASSET/SHA256SUMS"
  (cd "$TEMP_ASSET" && grep " MoonanBot-linux-x64-${RELEASE_VERSION}.tar.gz$" SHA256SUMS | sha256sum --check --strict)
else
  ASSET="$(readlink -f "$ASSET")"
  [[ -f "$ASSET" ]] || { echo "Asset does not exist: $ASSET" >&2; exit 1; }
fi

RELEASE_DIR="$APP_ROOT/releases/$RELEASE_VERSION"
STAGING_DIR="$APP_ROOT/releases/.${RELEASE_VERSION}.staging.$$"
rm -rf "$STAGING_DIR"
install -d -m 0755 "$STAGING_DIR"
tar -xzf "$ASSET" -C "$STAGING_DIR"
[[ -f "$STAGING_DIR/dist/cli.js" && -d "$STAGING_DIR/node_modules" ]] || { echo "Invalid MoonanBot release asset." >&2; exit 1; }

if [[ -f "$DATA_ROOT/moonanbot.sqlite" && -x "$APP_ROOT/runtime/bin/node" && -f "$APP_ROOT/current/dist/cli.js" ]]; then
  systemctl stop moonanbot.service 2>/dev/null || true
  BACKUP="$DATA_ROOT/backups/pre-${RELEASE_VERSION}-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  runuser -u moonanbot -- env MOONANBOT_DATA_DIR="$DATA_ROOT" "$APP_ROOT/runtime/bin/node" "$APP_ROOT/current/dist/cli.js" backup "$BACKUP"
fi

rm -rf "$RELEASE_DIR"
mv "$STAGING_DIR" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current"
chown -R root:root "$APP_ROOT/releases" "$APP_ROOT/current" 2>/dev/null || true
chmod -R go-w "$RELEASE_DIR"

install -m 0600 /dev/null "$CONFIG_ROOT/moonanbot.env"
cat >"$CONFIG_ROOT/moonanbot.env" <<EOF
NODE_ENV=production
MOONANBOT_DATA_DIR=$DATA_ROOT
MOONANBOT_HOST=127.0.0.1
MOONANBOT_PORT=21314
EOF

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=MoonanBot AI character service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=moonanbot
Group=moonanbot
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=$CONFIG_ROOT/moonanbot.env
ExecStart=$APP_ROOT/runtime/bin/node $APP_ROOT/current/dist/cli.js serve
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_ROOT
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF

FIRST_INSTALL=0
GENERATED_PASSWORD=""
if [[ ! -f "$DATA_ROOT/moonanbot.sqlite" ]]; then
  FIRST_INSTALL=1
  GENERATED_PASSWORD="$($APP_ROOT/runtime/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')"
  printf 'MOONANBOT_INITIAL_PASSWORD=%s\n' "$GENERATED_PASSWORD" >>"$CONFIG_ROOT/moonanbot.env"
fi

systemctl daemon-reload
systemctl enable --now moonanbot.service
READY=0
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:21314/api/v1/health >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if ((FIRST_INSTALL)); then
  sed -i '/^MOONANBOT_INITIAL_PASSWORD=/d' "$CONFIG_ROOT/moonanbot.env"
fi
if ((READY == 0)); then
  echo "MoonanBot did not become healthy. Inspect: journalctl -u moonanbot -n 100" >&2
  exit 1
fi

echo "MoonanBot $RELEASE_VERSION is installed and running at http://127.0.0.1:21314"
echo "The character is paused until you configure and start it in the WebUI."
if ((FIRST_INSTALL)); then
  echo "WebUI password (shown once): $GENERATED_PASSWORD"
else
  echo "Existing WebUI password preserved. Reset it with the MoonanBot CLI if needed."
fi
