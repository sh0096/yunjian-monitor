#!/bin/sh
# Fresh Ubuntu/Linux x86_64 installations. Review before running as root.
# Does not change firewall, SSH, reverse proxies or unrelated services.
set -eu
umask 077
if [ "$(id -u)" -ne 0 ]; then echo 'Run as root.' >&2; exit 1; fi
if [ "$(uname -m)" != x86_64 ]; then echo 'This installer expects Linux x86_64.' >&2; exit 1; fi
for tool in curl python3 tar ss systemctl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool missing: $tool" >&2; exit 1; }
done
if [ -e /opt/yunjian-monitor ] || [ -e /etc/yunjian-monitor ] || [ -e /etc/systemd/system/yunjian-monitor.service ]; then echo 'Existing installation found; refusing to overwrite.' >&2; exit 1; fi
if ss -lnt | awk '{print $4}' | grep -Eq '(^|:)8787$'; then echo 'Port 8787 is in use; refusing installation.' >&2; exit 1; fi
if [ ! -f /tmp/yunjian-source.tar.gz ]; then echo 'Source archive missing: /tmp/yunjian-source.tar.gz' >&2; exit 1; fi
mkdir -p /opt/yunjian-monitor/app /opt/yunjian-monitor/download /etc/yunjian-monitor
chmod 755 /opt/yunjian-monitor /opt/yunjian-monitor/app
chmod 700 /etc/yunjian-monitor
tar -xzf /tmp/yunjian-source.tar.gz --no-same-owner -C /opt/yunjian-monitor/app
version=v24.22.0
archive=node-${version}-linux-x64.tar.xz
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --limit-rate 2M --connect-timeout 15 --max-time 180 "https://nodejs.org/dist/${version}/${archive}" -o "/opt/yunjian-monitor/download/${archive}"
cd /opt/yunjian-monitor/download
# Pinned official checksum: https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
printf '%s  %s\n' cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008 "$archive" | sha256sum --check --status
python3 - "$archive" <<'PY'
import sys,tarfile
with tarfile.open(sys.argv[1], 'r:xz') as t:
    t.extractall('/opt/yunjian-monitor')
PY
mv "/opt/yunjian-monitor/node-${version}-linux-x64" /opt/yunjian-monitor/node
chmod -R a+rX /opt/yunjian-monitor/node /opt/yunjian-monitor/app
if ! id yunjian-monitor >/dev/null 2>&1; then useradd --system --home-dir /var/lib/yunjian-monitor --shell /usr/sbin/nologin yunjian-monitor; fi
install -d -m 700 -o yunjian-monitor -g yunjian-monitor /var/lib/yunjian-monitor
python3 - <<'PY'
from pathlib import Path
import secrets,os,base64
p=Path('/etc/yunjian-monitor/runtime.env')
key=base64.b64encode(secrets.token_bytes(32)).decode()
p.write_text('HOST=127.0.0.1\nPORT=8787\nPUBLIC_ORIGIN=http://127.0.0.1:8788\nNODE_ENV=development\nDATA_DIR=/var/lib/yunjian-monitor\nADMIN_PASSWORD_HASH=SETUP\nENCRYPTION_KEY='+key+'\nENABLE_JD_LEGACY=false\nRUN_MODE=server\nPOLL_SECONDS=5\n')
os.chmod(p,0o600)
PY
install -m 644 /opt/yunjian-monitor/app/deploy/yunjian-monitor.service /etc/systemd/system/yunjian-monitor.service
install -m 644 /opt/yunjian-monitor/app/deploy/yunjian-backup.service /etc/systemd/system/yunjian-backup.service
install -m 644 /opt/yunjian-monitor/app/deploy/yunjian-backup.timer /etc/systemd/system/yunjian-backup.timer
systemctl daemon-reload
systemctl enable --now yunjian-monitor.service
healthy=no
for attempt in 1 2 3 4 5; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8787/healthz >/dev/null; then healthy=yes; break; fi
  sleep 1
done
[ "$healthy" = yes ] || { echo 'App health check failed.' >&2; exit 1; }
systemctl enable --now yunjian-backup.timer
printf '%s\n' 'Yunjian installed on loopback 8787. Complete first-run setup through the SSH tunnel; see docs/部署.md.'
