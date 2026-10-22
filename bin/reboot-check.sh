#!/usr/bin/env bash
# bin/reboot-check.sh — did the box come back whole?
#
# Run:  sudo bash bin/reboot-check.sh Out:  out/98-reboot-check.txt
#
# Run this AFTER a reboot. It waits for the boot to finish before judging anything, because a check that runs mid-boot reports every service that has not started yet as broken.
#
# That is exactly what happened on the first run: it started at 23:34:18 while systemd still had jobs queued, so lnd was "activating", lnbits and albyhub were still waiting on lnd, and the ports they own were not open. None of that was a fault.
#
# This version:
#   * requires root, because ausearch, getsebool and firewall-cmd all
#     need it, and running as a user silently produced failures
#   * waits for "systemctl is-system-running" to stop saying "starting"
#   * waits for units that are still "activating" rather than calling
#     them broken
#   * checks behaviour, not just state: a service can be active and
#     still not be listening
set -uo pipefail

# ausearch, getsebool and firewall-cmd are in /usr/sbin, and this has to run as root to read the audit log at all.
export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

if [ "$(id -u)" -ne 0 ]; then
	echo "this needs root: ausearch, getsebool and firewall-cmd all do." >&2
	echo "  sudo bash bin/reboot-check.sh" >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname -- "$SCRIPT_DIR")"
mkdir -p "$REPO_DIR/out"
OUT="$REPO_DIR/out/98-reboot-check.txt"

exec >"$OUT" 2>&1
section() {
	echo
	echo "==================== $* ===================="
}

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

# is-active exits non-zero for anything that is not "active", so its output and its exit code have to be read separately. Appending a fallback with || corrupts the state string.
state_of() {
	timeout 10 systemctl is-active "$1" 2>/dev/null | head -1
}

section "WAITING FOR THE BOOT TO FINISH"

echo "  the box is still starting services; waiting up to 10 minutes."
echo "  bitcoind and lnd are the slow ones: bitcoind verifies the chain"
echo "  and lnd waits for it, so a cold boot takes a while."
echo

waited=0
while [ "$waited" -lt 600 ]; do
	st=$(timeout 10 systemctl is-system-running 2>/dev/null || true)

	# "starting" is the only state worth waiting on. "running" is good, "degraded" means something failed and waiting will not help.
	if [ "$st" != "starting" ] && [ -n "$st" ]; then
		echo "  system state: $st (after ${waited}s)"
		break
	fi

	if [ $((waited % 30)) -eq 0 ] && [ "$waited" -gt 0 ]; then
		printf '  %ss: %s\n' "$waited" "$(timeout 5 systemctl list-jobs --no-legend --no-pager 2>/dev/null | wc -l) jobs still queued"
	fi

	sleep 5
	waited=$((waited + 5))
done

if [ "$waited" -ge 600 ]; then
	echo "  !! still starting after 10 minutes."
	echo "  --- what is still running ---"
	timeout 10 systemctl list-jobs --no-pager 2>&1 | sed 's/^/    /'
fi

echo
echo "--- the ones that take longest, and whether they made it ---"
for u in bitcoind.service lnd.service; do
	printf '  %-24s ' "$u"
	t0=$(date +%s)
	for _ in $(seq 1 60); do
		s=$(state_of "$u")
		[ "$s" = "active" ] && break
		[ "$s" = "failed" ] && break
		sleep 5
	done
	printf '%s (waited %ss)\n' "$(state_of "$u")" "$(($(date +%s) - t0))"
done

section "BOOT"
uptime 2>&1 | sed 's/^/  /'
systemd-analyze 2>&1 | head -4 | sed 's/^/  /'

section "EVERY UNIT: ENABLED AND ACTIVE"

printf '%-48s %-12s %-10s %s\n' "UNIT" "ACTIVE" "ENABLED" "RESTARTS"

problems=0
not_active=()

for u in "${UNITS[@]}"; do
	a=$(state_of "$u")
	e=$(timeout 10 systemctl is-enabled "$u" 2>/dev/null | head -1)
	n=$(timeout 10 systemctl show "$u" -p NRestarts --value 2>/dev/null)

	printf '%-48s %-12s %-10s %s\n' "$u" "${a:-unknown}" "${e:-unknown}" "${n:-?}"

	if [ "$a" != "active" ]; then
		not_active+=("$u")
		problems=$((problems + 1))
	fi

	if [ "$e" != "enabled" ] && [ "$e" != "enabled-runtime" ]; then
		echo "      ^^ NOT ENABLED, so it will not start at boot"
	fi

	if [ -n "${n:-}" ] && [ "$n" != "0" ]; then
		echo "      ^^ restarted $n time(s)"
	fi
done

if [ "${#not_active[@]}" -gt 0 ]; then
	echo
	echo "--- why the ones that are not active are not ---"
	for u in "${not_active[@]}"; do
		echo
		echo "  ########## $u ##########"
		timeout 10 systemctl show "$u" \
			-p ActiveState -p SubState -p Result -p ExecMainStatus \
			--no-pager 2>&1 | sed 's/^/    /'
		timeout 10 journalctl -u "$u" -b --no-pager -n 8 2>&1 | sed 's/^/    /' | tail -9
	done
fi

section "FAILED UNITS"
if timeout 10 systemctl --failed --no-legend --no-pager 2>/dev/null | grep -q .; then
	timeout 10 systemctl --failed --no-legend --no-pager 2>&1 | sed 's/^/  /'
	problems=$((problems + 1))
else
	echo "  (none)"
fi

section "THE PORTS ARE ACTUALLY LISTENING"

# A service can be active and not listening, which is the difference between "started" and "working".
check_port() {
	local port="$1" what="$2"
	printf '  %-8s %-30s ' "$port" "$what"
	if ss -tln 2>/dev/null | grep -qE ":$port[[:space:]]"; then
		echo "listening"
	else
		echo "NOT LISTENING"
		problems=$((problems + 1))
	fi
}

check_port 443 "caddy https"
check_port 5000 "lnbits"
check_port 6511 "peaks"
check_port 3000 "defector"
check_port 10009 "lnd grpc"
check_port 18080 "lnd rest"
check_port 8080 "urbit http"
check_port 8775 "radicle-httpd"
check_port 8776 "radicle-node"
check_port 8332 "bitcoind rpc"

section "THE SERVICES ARE TALKING TO EACH OTHER"

echo "--- lnd's wallet, which is the thing that used to be locked ---"
timeout 10 journalctl -u lnd -b --no-pager 2>&1 \
	| grep -iE 'wallet.*unlock|wallet.*locked|unlocked wallet|Waiting for wallet' \
	| tail -3 | sed 's/^/  /'
echo

echo "--- lnbits reached lnd ---"
if timeout 10 journalctl -u lnbits -b --no-pager 2>&1 | grep -qiE 'LndWallet|wallet.*(ok|ready|connected)'; then
	echo "  lnbits is using the LndWallet backend"
else
	timeout 10 journalctl -u lnbits -b --no-pager 2>&1 \
		| grep -iE 'error|wallet|backend' | tail -5 | sed 's/^/  /'
fi
echo

echo "--- caddy: certificates and any errors ---"
echo "  certificates on disk:"
ls -1 /var/lib/caddy/.local/share/caddy/certificates/*/ 2>/dev/null | head -8 | sed 's/^/    /'
echo
echo "  errors since boot (certificates are cached, so 'obtained' is"
echo "  usually 0 on a reboot - what matters is that nothing failed):"
timeout 10 journalctl -u caddy -b --no-pager 2>&1 \
	| grep '"level":"error"' | tail -6 | sed 's/^/    /' \
	|| echo "    (none)"

section "THE DATA DISKS"
df -h / /srv /srv/hdd 2>&1 | sed 's/^/  /'
echo
printf '  %-46s ' "/srv/hdd mounted"
if findmnt /srv/hdd >/dev/null 2>&1; then echo "yes"; else
	echo "NO - bitcoind and lnd would fail without it"
	problems=$((problems + 1))
fi
printf '  %-46s ' "/srv/hdd in fstab"
if grep -qE '[[:space:]]/srv/hdd[[:space:]]' /etc/fstab 2>/dev/null; then
	echo "yes"
else
	echo "NOT IN FSTAB"
	problems=$((problems + 1))
fi

# The root filesystem has been at 99% throughout this migration.
used=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "${used:-}" ] && [ "$used" -ge 90 ]; then
	echo
	echo "  !! / is ${used}% full ($(df -h / | tail -1 | awk '{print $4}') free)."
	echo "     Not caused by this migration, but a full root filesystem"
	echo "     breaks services in confusing ways. Worth clearing."
fi

section "THE FIREWALL"

# firewall-cmd needs the daemon. If firewalld is not running, the box has no firewall at all, and every 'permanent' rule is dormant.
if ! systemctl is-active --quiet firewalld 2>/dev/null; then
	echo "  !! firewalld is NOT RUNNING"
	echo "     That means no filtering at all right now, whatever the"
	echo "     permanent configuration says."
	echo
	timeout 10 systemctl show firewalld -p ActiveState -p Result --no-pager 2>&1 | sed 's/^/    /'
	timeout 10 journalctl -u firewalld -b --no-pager -n 6 2>&1 | sed 's/^/    /' | tail -7
	printf '  %-46s ' "enabled at boot"
	timeout 10 systemctl is-enabled firewalld 2>&1 | sed 's/^/  /'
	problems=$((problems + 1))
else
	echo "  firewalld: running"
	echo
	echo "  --- the zone in force ---"
	firewall-cmd --get-active-zones 2>&1 | sed 's/^/    /'
	echo
	echo "  --- open ports ---"
	firewall-cmd --list-ports 2>&1 | tr ' ' '\n' | grep -v '^$' | sed 's/^/    /'
	echo
	echo "  --- are 80 and 443 open permanently? ---"
	for p in 80 443; do
		printf '    %-6s ' "$p"
		if firewall-cmd --permanent --query-port="$p/tcp" >/dev/null 2>&1; then
			echo "yes"
		else
			echo "NO"
			problems=$((problems + 1))
		fi
	done
fi

section "SELINUX"

if command -v ausearch >/dev/null 2>&1; then
	n=$(ausearch -m avc -ts boot 2>/dev/null | grep -c 'denied' || true)
	echo "  denials this boot: ${n:-0}"
	if [ "${n:-0}" -gt 0 ]; then
		ausearch -m avc -ts boot 2>/dev/null | grep 'denied' | tail -8 | sed 's/^/    /'
	fi
else
	echo "  ausearch is not installed: zypper install policycoreutils-python-utils"
fi

echo
printf '  %-46s ' "httpd_can_network_connect"
if command -v getsebool >/dev/null 2>&1; then
	getsebool httpd_can_network_connect 2>&1 | sed 's/^.*--> //'
else
	echo "getsebool not found"
fi
echo "  (must be on, or caddy cannot renew certificates)"

section "SUMMARY"

if [ "$problems" -eq 0 ]; then
	echo "  everything is up, enabled and listening."
	echo
	echo "  The box came back whole."
else
	echo "  $problems item(s) worth looking at, listed above."
	echo
	echo "  Some of these are consequences of one cause: if lnd is not"
	echo "  active, lnbits and albyhub cannot be either, because both"
	echo "  Require= lnd.service."
fi

echo
echo "  Details of any unit:"
echo "    journalctl -u <unit> -b -n 50 --no-pager"

echo
echo "=== DONE ==="
