#!/bin/bash
# KANP tracker Pi installer. Run on the Raspberry Pi:
#   sudo bash pi/install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> creating kanp user and data dir"
id -u kanp &>/dev/null || useradd --system --home /var/lib/kanp --shell /usr/sbin/nologin kanp
mkdir -p /var/lib/kanp
chown -R kanp:kanp /var/lib/kanp

echo "==> installing code to /opt/kanp"
mkdir -p /opt/kanp
cp -r "$REPO_DIR/pi" "$REPO_DIR/js" "$REPO_DIR/css" /opt/kanp/
cp "$REPO_DIR/kanp.html" "$REPO_DIR/atc.html" /opt/kanp/ 2>/dev/null || true
chown -R kanp:kanp /opt/kanp

echo "==> seeding site config (edit /etc/kanp/site.env to re-site the tracker)"
mkdir -p /etc/kanp
[ -f /etc/kanp/site.env ] || cp /opt/kanp/pi/site.env.example /etc/kanp/site.env

echo "==> installing systemd units"
cp /opt/kanp/pi/kanp-collector.service /etc/systemd/system/
cp /opt/kanp/pi/kanp-api.service /etc/systemd/system/
cp /opt/kanp/pi/kanp-export.service /etc/systemd/system/
cp /opt/kanp/pi/kanp-export.timer /etc/systemd/system/
cp /opt/kanp/pi/kanp-atc.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kanp-collector.service kanp-api.service kanp-export.timer
# enable --now is a no-op for already-running units — restart to pick up new code
systemctl restart kanp-collector.service kanp-api.service

# ATC recorder needs ffmpeg (and ideally whisper.cpp — see pi/README.md).
# Only start it once ffmpeg exists so a fresh install doesn't crash-loop.
if command -v ffmpeg &>/dev/null; then
  systemctl enable --now kanp-atc.service
  systemctl restart kanp-atc.service
else
  echo "!! ffmpeg not found — kanp-atc.service installed but not enabled."
  echo "   sudo apt install -y ffmpeg   then: sudo systemctl enable --now kanp-atc"
fi

echo
echo "done."
echo "  status:   systemctl status kanp-collector kanp-api"
echo "  logs:     journalctl -u kanp-collector -f"
echo "  API:      http://$(hostname -I | awk '{print $1}'):8787/api/status"
echo "  tracker:  http://$(hostname -I | awk '{print $1}'):8787/"
echo
echo "re-run this script after 'git pull' to deploy updates."
