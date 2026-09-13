#!/bin/bash
# pi/recover.sh — one-shot recovery for the Pi tracker after a full-disk stop.
#
# Written for the 2026-09-12 incident (root filled, SQLite WAL could not
# checkpoint, exporter push failed, site went stale) but idempotent, so it is
# safe to run any time the changelog page says the snapshots are stale:
#
#   curl -fsSL https://raw.githubusercontent.com/nuvig/nuvig.github.io/main/pi/recover.sh | sudo bash
#
# What it does, in order, and reports in one line each:
#   1. site.env: 45-day retention for positions and for ATC clips.
#   2. ATC clips go to the USB stick (LABEL=kanp-atc, ext4) mounted at the
#      recorder's own directory, /var/lib/kanp/atc, so the hardened unit
#      needs no change; clips left on root are deleted first.
#   3. Restarts the collector, API, heal and export timers.
#   4. Runs an export now. If it fails, re-clones the traffic-data checkout
#      (a push that died mid-write on a full disk leaves it unusable) and
#      tries once more.
#   5. Verifies from GitHub that the branch was just pushed, and from the DB
#      that fixes are being stored, and prints ALL GOOD or NOT FIXED with why.
set -u

ENV=/etc/kanp/site.env
KDIR=/var/lib/kanp
EXPORT=$KDIR/traffic-data
REPO=nuvig/nuvig.github.io

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
mkdir -p "$(dirname "$ENV")"; touch "$ENV"

setenv() {  # key value — set or uncomment a line in site.env
  if grep -qE "^#?$1=" "$ENV"; then
    sed -i "s|^#\?$1=.*|$1=$2|" "$ENV"
  else
    echo "$1=$2" >> "$ENV"
  fi
}

echo "== KANP recover $(date '+%Y-%m-%d %H:%M %Z')"

# 1. retention -------------------------------------------------------------
setenv KANP_RETENTION_DAYS 45
setenv KANP_ATC_RETENTION_DAYS 45
# The collector installed before ec459e63 measures the cap on the FILE size,
# and the file never shrinks (auto_vacuum never took), so once kanp.db crossed
# 8000 MB its emergency loop dropped "30 more days" twelve times an hour —
# every row, including today's — and the file stayed the same size. Raise the
# cap above the file until the new collector (live pages + WAL) is installed.
setenv KANP_MAX_DB_MB 20000
echo "retention: positions 45 d · ATC clips 45 d · size cap 20000 MB"

# 2. ATC clips onto the stick -----------------------------------------------
# The stick is mounted AT the recorder's default directory. The first attempt
# (2026-09-12) mounted it at /mnt/atc and added a ReadWritePaths= drop-in for
# the hardened unit, and the recorder still could not write there; mounting
# it where the unit is already allowed to write needs no sandbox change and
# nothing to debug.
ATC_DIR=$KDIR/atc
systemctl stop kanp-atc
mountpoint -q /mnt/atc && umount /mnt/atc
sed -i '/LABEL=kanp-atc/d' /etc/fstab
echo "LABEL=kanp-atc $ATC_DIR ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
rm -rf /etc/systemd/system/kanp-atc.service.d
systemctl daemon-reload
setenv KANP_ATC_DIR "$ATC_DIR"
if ! mountpoint -q "$ATC_DIR"; then
  # anything recorded onto root meanwhile is not worth keeping over the disk
  rm -rf "$ATC_DIR"; mkdir -p "$ATC_DIR"
  mount "$ATC_DIR" 2>/dev/null
fi
if mountpoint -q "$ATC_DIR"; then
  chown kanp:kanp "$ATC_DIR"
  systemctl start kanp-atc
  sleep 8
  if journalctl -u kanp-atc --since "-8s" --no-pager -o cat | grep -qiE "read-only|permission denied|errno"; then
    ATC="recorder started but logged an error — journalctl -u kanp-atc -n 20"
  else
    ATC="recorder → stick at $ATC_DIR ($(df -h "$ATC_DIR" | awk 'NR==2{print $4}') free) · $(systemctl is-active kanp-atc)"
  fi
else
  ATC="stick not mounted — recorder left stopped so it cannot fill root"
fi
echo "atc: $ATC"

# 3. services ---------------------------------------------------------------
systemctl reset-failed kanp-collector kanp-export.service 2>/dev/null
systemctl start kanp-collector kanp-api kanp-heal.timer kanp-export.timer
echo "services: collector $(systemctl is-active kanp-collector) · api $(systemctl is-active kanp-api) · export timer $(systemctl is-active kanp-export.timer)"

# 4. export now -------------------------------------------------------------
ERR=""
try_export() {
  local start; start=$(date +%s)
  rm -f "$EXPORT/.git/index.lock"
  if systemctl start kanp-export.service; then return 0; fi
  ERR=$(journalctl -u kanp-export.service --since "@$start" --no-pager -o cat | grep -v '^$' | tail -4)
  return 1
}
EXPORT_OK=0
if try_export; then
  EXPORT_OK=1
else
  echo "export failed once — re-cloning the traffic-data checkout"
  URL=$(git -C "$EXPORT" config --get remote.origin.url 2>/dev/null || true)
  if [ -n "$URL" ]; then
    rm -rf "$EXPORT.new"
    if sudo -u kanp -H git clone -q --branch traffic-data --depth 1 "$URL" "$EXPORT.new" 2>/tmp/kanp-clone.err; then
      rm -rf "$EXPORT.old"
      mv "$EXPORT" "$EXPORT.old" && mv "$EXPORT.new" "$EXPORT" && rm -rf "$EXPORT.old"
      try_export && EXPORT_OK=1
    else
      ERR="$ERR"$'\n'"re-clone failed: $(tail -1 /tmp/kanp-clone.err)"
    fi
    rm -f /tmp/kanp-clone.err
  else
    ERR="$ERR"$'\n'"$EXPORT has no git remote — see the setup note in pi/exporter.py"
  fi
fi

# 5. verify -----------------------------------------------------------------
NOW=$(date +%s)
NEWEST=$(sudo -u kanp python3 -c "import sqlite3;d=sqlite3.connect('file:$KDIR/kanp.db?mode=ro',uri=True);print(d.execute('select coalesce(max(ts),0) from positions').fetchone()[0])" 2>/dev/null || echo 0)
DB_AGE=$(( NOW - NEWEST ))
PUB=$(curl -fsS "https://api.github.com/repos/$REPO/branches/traffic-data" 2>/dev/null | python3 -c "
import json,sys,datetime
t=json.load(sys.stdin)['commit']['commit']['committer']['date']
print(int(datetime.datetime.strptime(t,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))" 2>/dev/null || echo 0)
PUB_AGE=$(( NOW - PUB ))

echo "disk: $(df -h / | awk 'NR==2{print $4" free on root ("$5" used)"}')"
echo "collector: last fix stored ${DB_AGE}s ago"
echo "site: traffic-data last pushed $(( PUB_AGE / 60 )) min ago"
echo

if [ "$EXPORT_OK" = 1 ] && [ "$PUB_AGE" -lt 600 ] && [ "$DB_AGE" -lt 180 ]; then
  echo "ALL GOOD — the site is publishing again."
  exit 0
fi
echo "NOT FIXED:"
[ "$DB_AGE" -ge 180 ] && echo "  collector is not storing fixes — journalctl -u kanp-collector -n 20"
[ "$EXPORT_OK" != 1 ] && echo "  export failed:" && echo "$ERR" | sed 's/^/    /'
[ "$EXPORT_OK" = 1 ] && [ "$PUB_AGE" -ge 600 ] && echo "  export ran but GitHub does not show a fresh push (${PUB_AGE}s) — journalctl -u kanp-export -n 20"
exit 1
