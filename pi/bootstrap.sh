#!/bin/bash
# pi/bootstrap.sh — fresh-Pi install of the KANP tracker, one line:
#
#   curl -fsSL https://raw.githubusercontent.com/nuvig/nuvig.github.io/main/pi/bootstrap.sh | sudo bash
#
# Written after the 2026-10-14 SD card death. Flash Raspberry Pi OS Lite with
# SSH enabled, boot, plug in a blank USB flash drive, run the line. Idempotent:
# a second run repairs rather than redoes.
#
# What it does, one line of output each:
#   1. apt: git, python3, ffmpeg (the ATC recorder needs it).
#   2. Data drive: finds ONE USB disk that is blank or FAT/exFAT (a new stick)
#      or already labelled kanp-data, formats it ext4 as kanp-data and mounts
#      it AT /var/lib/kanp — the DB, its WAL, the export clone and the ATC
#      clips all live there, so the SD card holds only the OS. A disk holding
#      anything else is refused by name, never wiped. The old ATC stick
#      (LABEL=kanp-atc) is mounted inside it at /var/lib/kanp/atc if present.
#   3. Code: clones the repo to /opt/kanp-src and runs pi/install.sh.
#   4. Publishing: asks for a GitHub fine-grained token (typed, never echoed)
#      and clones the traffic-data branch for the exporter; the export timer
#      is set to 15 min like the old Pi.
#   5. SD-card wear: swap off, journald capped at 100 MB.
#   6. Exports once and verifies from GitHub → ALL GOOD or NOT FIXED with why.
#
# Token: github.com/settings/personal-access-tokens → Fine-grained →
# repository nuvig/nuvig.github.io only → Contents: Read and write
# (+ Administration: Read-only for the visitor-stats line, optional).
# Skip the prompt (Enter) and the Pi collects but does not publish; rerun later.
# Or pass the token visibly:  curl … | sudo bash -s -- github_pat_…
set -u

REPO=nuvig/nuvig.github.io
SRC=/opt/kanp-src
KDIR=/var/lib/kanp
EXPORT=$KDIR/traffic-data
ENV=/etc/kanp/site.env
TTY=/dev/tty

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
echo "== KANP bootstrap $(date '+%Y-%m-%d %H:%M %Z') on $(hostname) ($(tr -d '\0' < /proc/device-tree/model 2>/dev/null))"

setenv() {  # key value — set or uncomment a line in site.env
  mkdir -p "$(dirname "$ENV")"; touch "$ENV"
  if grep -qE "^#?$1=" "$ENV"; then
    sed -i "s|^#\?$1=.*|$1=$2|" "$ENV"
  else
    echo "$1=$2" >> "$ENV"
  fi
}

# 1. packages ----------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || echo "apt update had errors (continuing)"
if apt-get install -y -qq git python3 ffmpeg >/tmp/kanp-apt.log 2>&1; then
  echo "packages: git $(git --version | awk '{print $3}') · python $(python3 -c 'import sys;print(sys.version.split()[0])') · ffmpeg $(command -v ffmpeg >/dev/null && echo ok || echo MISSING)"
else
  echo "packages: apt install failed — $(tail -1 /tmp/kanp-apt.log)"
fi

# 2. data drive --------------------------------------------------------------
ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null | head -1)
DATA_DEV=""
if findmnt -no SOURCE "$KDIR" >/dev/null 2>&1 && [ "$(lsblk -no LABEL "$(findmnt -no SOURCE "$KDIR")" 2>/dev/null)" = kanp-data ]; then
  DATA_DEV=$(findmnt -no SOURCE "$KDIR")
  DRIVE="already mounted · $DATA_DEV"
else
  CANDS=(); REFUSED=()
  while read -r name tran; do
    [ "$tran" = usb ] || continue
    [ "$(basename "$name")" = "$ROOT_DISK" ] && continue
    # every filesystem on the disk: blank / vfat / exfat / kanp-data are fair game
    bad=""; has_data=""
    while read -r fs label; do
      [ "$label" = kanp-atc ] && bad="holds the ATC clips"
      [ "$label" = kanp-data ] && has_data=1
      case "$fs" in ""|vfat|exfat) ;; *) [ "$label" = kanp-data ] || bad="has a $fs filesystem${label:+ labelled $label}";; esac
    done < <(lsblk -rno FSTYPE,LABEL "$name")
    if [ -n "$bad" ]; then REFUSED+=("$name ($bad)"); else CANDS+=("$name${has_data:+:keep}"); fi
  done < <(lsblk -dnro NAME,TRAN -p)
  if [ ${#CANDS[@]} -eq 1 ]; then
    DATA_DEV=${CANDS[0]%%:keep}
    SIZE=$(lsblk -dno SIZE "$DATA_DEV")
    if [[ ${CANDS[0]} == *:keep ]]; then
      DRIVE="reusing kanp-data on $DATA_DEV ($SIZE)"
    else
      echo "data drive: formatting $DATA_DEV ($SIZE, $(lsblk -dno MODEL "$DATA_DEV" | xargs)) as ext4 kanp-data"
      systemctl stop kanp-collector kanp-api kanp-atc 2>/dev/null
      umount -q "$DATA_DEV"* 2>/dev/null
      wipefs -aq "$DATA_DEV"
      if mkfs.ext4 -q -F -L kanp-data "$DATA_DEV" >/tmp/kanp-mkfs.log 2>&1; then
        DRIVE="formatted $DATA_DEV ($SIZE)"
      else
        DRIVE="FORMAT FAILED: $(tail -1 /tmp/kanp-mkfs.log)"; DATA_DEV=""
      fi
    fi
  elif [ ${#CANDS[@]} -eq 0 ]; then
    DRIVE="no blank USB drive found${REFUSED:+ (refused: ${REFUSED[*]})} — plug one in and rerun"
  else
    DRIVE="more than one blank USB drive: ${CANDS[*]} — leave only the data stick in and rerun"
  fi
  if [ -n "$DATA_DEV" ]; then
    # anything written to /var/lib/kanp on the card before the stick arrived
    # is moved onto the stick, not lost
    mkdir -p "$KDIR"
    if [ -n "$(ls -A "$KDIR" 2>/dev/null)" ] && ! mountpoint -q "$KDIR"; then
      mkdir -p /mnt/kanp-stage && mount "$DATA_DEV" /mnt/kanp-stage && cp -a "$KDIR"/. /mnt/kanp-stage/ && umount /mnt/kanp-stage && rm -rf "${KDIR:?}"/*
    fi
    sed -i '/LABEL=kanp-data/d' /etc/fstab
    echo "LABEL=kanp-data $KDIR ext4 defaults,noatime,commit=30,nofail,x-systemd.device-timeout=15 0 2" >> /etc/fstab
    systemctl daemon-reload
    mountpoint -q "$KDIR" || mount "$KDIR"
  fi
fi
if mountpoint -q "$KDIR"; then
  echo "data drive: $DRIVE · $(df -h "$KDIR" | awk 'NR==2{print $4}') free"
else
  echo "data drive: $DRIVE"
  echo "NOT FIXED: nothing installed — the tracker must not write to the SD card."
  exit 1
fi
# old ATC stick, if it is plugged in
if blkid -L kanp-atc >/dev/null 2>&1; then
  sed -i '/LABEL=kanp-atc/d' /etc/fstab
  echo "LABEL=kanp-atc $KDIR/atc ext4 defaults,noatime,nofail,x-systemd.device-timeout=15 0 2" >> /etc/fstab
  mkdir -p "$KDIR/atc"; systemctl daemon-reload
  mountpoint -q "$KDIR/atc" || mount "$KDIR/atc"
  echo "atc stick: $(mountpoint -q "$KDIR/atc" && echo "mounted at $KDIR/atc" || echo "present but failed to mount")"
else
  echo "atc stick: not plugged in — clips go to the data drive"
fi
setenv KANP_ATC_DIR "$KDIR/atc"

# 3. code ----------------------------------------------------------------------
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull -q --ff-only 2>/tmp/kanp-git.log || echo "git pull: $(tail -1 /tmp/kanp-git.log)"
else
  git clone -q "https://github.com/$REPO.git" "$SRC" 2>/tmp/kanp-git.log || { echo "git clone failed: $(tail -1 /tmp/kanp-git.log)"; exit 1; }
fi
echo "code: $SRC @ $(git -C "$SRC" log -1 --format='%h %cs')"
setenv KANP_RETENTION_DAYS 45
setenv KANP_ATC_RETENTION_DAYS 45
if bash "$SRC/pi/install.sh" >/tmp/kanp-install.log 2>&1; then
  echo "install: collector $(systemctl is-active kanp-collector) · api $(systemctl is-active kanp-api) · atc $(systemctl is-active kanp-atc) · heal timer $(systemctl is-active kanp-heal.timer)"
else
  echo "install: FAILED — $(grep -v '^==>' /tmp/kanp-install.log | tail -3 | tr '\n' ' ')"
fi
chown kanp:kanp "$KDIR" "$KDIR/atc" 2>/dev/null

# 4. publishing -------------------------------------------------------------
mkdir -p /etc/systemd/system/kanp-export.timer.d
cat > /etc/systemd/system/kanp-export.timer.d/override.conf <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*:0/15
RandomizedDelaySec=60
EOF
systemctl daemon-reload
systemctl restart kanp-export.timer
HAVE_CLONE=0
sudo -u kanp -H git -C "$EXPORT" rev-parse --is-inside-work-tree >/dev/null 2>&1 && HAVE_CLONE=1
TOKEN="${1:-}"                 # curl … | sudo bash -s -- <token>  skips the prompt
if [ -z "$TOKEN" ] && [ -e "$TTY" ]; then
  if [ "$HAVE_CLONE" = 1 ]; then
    printf "Paste a NEW GitHub token to replace the one in use (Enter alone keeps it): " > "$TTY"
  else
    printf "Paste the GitHub token, then press Enter (Enter alone skips): " > "$TTY"
  fi
  IFS= read -r TOKEN < "$TTY"
fi
TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
if [ "$HAVE_CLONE" = 1 ] && [ -n "$TOKEN" ]; then
  sudo -u kanp -H git -C "$EXPORT" remote set-url origin "https://$TOKEN@github.com/$REPO.git"
  if sudo -u kanp -H git -C "$EXPORT" ls-remote -q --heads origin traffic-data >/dev/null 2>/tmp/kanp-ls.err; then
    echo "publishing: token replaced"
  else
    echo "publishing: new token REJECTED by GitHub — $(sed 's/'"$TOKEN"'/<token>/g' /tmp/kanp-ls.err | tail -1)"
  fi
  rm -f /tmp/kanp-ls.err
elif [ "$HAVE_CLONE" = 1 ]; then
  echo "publishing: export clone already in place"
else
  if [ -n "$TOKEN" ]; then
    rm -rf "$EXPORT"
    if sudo -u kanp -H git clone -q --branch traffic-data --depth 1 "https://$TOKEN@github.com/$REPO.git" "$EXPORT" 2>/tmp/kanp-clone.err; then
      sudo -u kanp -H git -C "$EXPORT" config user.name nuvig
      sudo -u kanp -H git -C "$EXPORT" config user.email nuvig@users.noreply.github.com
      echo "publishing: traffic-data cloned ($(du -sh "$EXPORT" | cut -f1))"
    else
      echo "publishing: clone FAILED — $(sed 's/'"$TOKEN"'/<token>/g' /tmp/kanp-clone.err | tail -1)"
    fi
    rm -f /tmp/kanp-clone.err
  else
    echo "publishing: skipped — no token (collector runs, nothing reaches the site; rerun this line to add it)"
  fi
fi

# 5. SD-card wear --------------------------------------------------------------
systemctl disable --now dphys-swapfile 2>/dev/null; swapoff -a 2>/dev/null
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/kanp.conf
systemctl restart systemd-journald 2>/dev/null
echo "sd card: swap off · journal capped 100 MB · root $(df -h / | awk 'NR==2{print $4" free"}')"

# 6. export + verify -----------------------------------------------------------
EXPORT_OK=0; ERR=""
if sudo -u kanp -H git -C "$EXPORT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  sleep 20                      # let the collector store something first
  START=$(date +%s)
  if systemctl start kanp-export.service; then EXPORT_OK=1; else
    ERR=$(journalctl -u kanp-export.service --since "@$START" --no-pager -o cat | grep -v '^$' | tail -4)
  fi
fi
NOW=$(date +%s)
NEWEST=$(sudo -u kanp python3 -c "import sqlite3;d=sqlite3.connect('file:$KDIR/kanp.db?mode=ro',uri=True);print(d.execute('select coalesce(max(ts),0) from positions').fetchone()[0])" 2>/dev/null || echo 0)
DB_AGE=$(( NOW - ${NEWEST%.*} ))
PUB=$(curl -fsS "https://api.github.com/repos/$REPO/branches/traffic-data" 2>/dev/null | python3 -c "
import json,sys,datetime
t=json.load(sys.stdin)['commit']['commit']['committer']['date']
print(int(datetime.datetime.strptime(t,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))" 2>/dev/null || echo 0)
PUB_AGE=$(( NOW - PUB ))
API=$(curl -fsS -m 5 http://127.0.0.1:8787/api/status 2>/dev/null | head -c 80)

echo
echo "collector: last fix stored ${DB_AGE}s ago"
echo "api: ${API:-not answering}"
echo "site: traffic-data last pushed $(( PUB_AGE / 60 )) min ago"
echo

if [ "$DB_AGE" -lt 180 ] && [ -n "$API" ] && { [ "$EXPORT_OK" = 1 ] && [ "$PUB_AGE" -lt 600 ]; }; then
  echo "ALL GOOD — collecting and publishing from the flash drive."
  exit 0
fi
if [ "$DB_AGE" -lt 180 ] && [ -n "$API" ] && ! sudo -u kanp -H git -C "$EXPORT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "COLLECTING, NOT PUBLISHING — rerun with a GitHub token to publish."
  exit 0
fi
echo "NOT FIXED:"
[ "$DB_AGE" -ge 180 ] && echo "  collector is not storing fixes — journalctl -u kanp-collector -n 20"
[ -z "$API" ] && echo "  API not answering on 8787 — journalctl -u kanp-api -n 20"
[ "$EXPORT_OK" != 1 ] && [ -n "$ERR" ] && echo "  export failed:" && echo "$ERR" | sed 's/^/    /'
[ "$EXPORT_OK" = 1 ] && [ "$PUB_AGE" -ge 600 ] && echo "  export ran but GitHub shows no fresh push — journalctl -u kanp-export -n 20"
exit 1
