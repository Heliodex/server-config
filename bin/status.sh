#!/usr/bin/env bash
# bin/status.sh — what is actually running, and what is enabled?
#
# Run:  bash bin/status.sh
# Out:  out/status.txt  (and a summary on the terminal)
#
# The units are installed but NOT enabled by 30-install.sh, so after a reboot none of them start. This shows the difference between "the unit file exists" and "the unit is on and running".
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname -- "$SCRIPT_DIR")"
mkdir -p "$REPO_DIR/out"
OUT="$REPO_DIR/out/status.txt"

exec >"$OUT" 2>&1

UNITS=(
	radicle-node.service
	bitcoind.service
	lnd.service
	lnbits.service
	albyhub.service
	radicle-httpd.service
	peaks.service
	mercury-core.service
	defector.service
	coputer-gateway@coputer.heliodex.cf.service
	coputer-wallflower@coputer.heliodex.cf.service
	coputer-litecode.service
	paper@LHCRJpaper.service
	urbit.service
	caddy.service
)

echo "# server status at $(date -Is)"
echo
echo "==================== SUMMARY ===================="
printf '%-48s %-10s %-12s %s\n' "UNIT" "ACTIVE" "ENABLED" "RESTARTS"
for u in "${UNITS[@]}"; do
	# is-active and is-enabled exit non-zero for anything that is not
	# active or not enabled, while still printing the answer to stdout.
	# Appending a fallback with || produces two lines and shifts the
	# whole table, so take the output and the exit code separately.
	a=$(systemctl is-active "$u" 2>/dev/null | head -1)
	e=$(systemctl is-enabled "$u" 2>/dev/null | head -1)
	[ -n "$a" ] || a="n/a"
	[ -n "$e" ] || e="n/a"
	n=$(systemctl show "$u" -p NRestarts --value 2>/dev/null || echo "?")
	printf '%-48s %-10s %-12s %s\n' "$u" "$a" "$e" "$n"
done

echo
echo "==================== FAILED UNITS ===================="
systemctl --failed --no-pager --no-legend 2>&1 | head -20
if ! systemctl --failed --no-legend --no-pager 2>/dev/null | grep -q .; then
	echo "(none)"
fi

echo
echo "==================== ENABLED AT BOOT ===================="
systemctl list-unit-files --state=enabled --no-legend --no-pager 2>&1 \
	| grep -E 'radicle|bitcoin|lnd|lnbits|albyhub|peaks|mercury|defector|coputer|paper|urbit|caddy|surreal' \
	|| echo "(none of our units are enabled)"
echo
echo "--- and the multi-user.target wants directory ---"
ls -la /etc/systemd/system/multi-user.target.wants/ 2>&1 | grep -E 'radicle|bitcoin|lnd|lnbits|albyhub|peaks|mercury|defector|coputer|paper|urbit|caddy' || echo "(none)"

echo
echo "==================== PER-UNIT DETAIL ===================="
for u in "${UNITS[@]}"; do
	echo
	echo "########## $u ##########"
	systemctl show "$u" \
		-p LoadState -p ActiveState -p SubState -p UnitFileState \
		-p NRestarts -p Result -p ExecMainStatus -p ExecMainCode \
		-p User -p FragmentPath -p ConditionResult \
		--no-pager 2>&1 | sed 's/^/  /'
	echo "  --- last 8 log lines ---"
	journalctl -u "$u" -b --no-pager -n 8 2>&1 | sed 's/^/  /' | tail -10
done

echo
echo "==================== BOOT SUMMARY ===================="
systemd-analyze 2>&1 | head -5
echo
echo "--- units that failed during this boot ---"
journalctl -b -p err --no-pager 2>&1 | grep -E 'Failed|failed|error' | tail -20 || echo "(none)"

echo
echo "==================== SELINUX DENIALS ===================="
if command -v ausearch >/dev/null 2>&1; then
	ausearch -m avc -ts boot 2>&1 | grep -E 'denied' | tail -15 || echo "(none)"
else
	echo "(ausearch not installed)"
fi

echo
echo "==================== LISTENING PORTS ===================="
ss -tlnp 2>/dev/null | grep -E '127.0.0.1|0.0.0.0|\[::\]' | head -30

echo
echo "==================== DISK ===================="
df -h / /srv/hdd 2>&1
echo
free -h 2>&1

echo
echo "==================== WHAT TO DO NEXT ===================="
cat <<'EOF'

If the summary shows "disabled" for most units, that is expected: the
installer puts the unit files in place but does not enable them, so
nothing starts at boot. To start and enable them all:

  sudo bash bin/60-enable-all.sh

That enables and starts each one, in dependency order, and reports
which failed.

To look at one service in detail:

  systemctl status <unit>
  journalctl -u <unit> -b -n 50 --no-pager
EOF

echo
echo "=== DONE ==="
