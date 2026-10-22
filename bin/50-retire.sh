#!/usr/bin/env bash
# bin/50-retire.sh — remove the old supervisors and the unused t3code unit.
#
# Run:  sudo bash bin/50-retire.sh
#
# Disables and removes:
#   startup.service    - only ran four non-permanent firewall-cmd calls
#   gateway.service    - superseded by coputer-gateway@.service
#   litecode.service   - superseded by coputer-litecode.service
#   wallflower.service - superseded by coputer-wallflower@.service
#   t3code.service     - unused
#
# Also installs the permanent firewalld rules that startup.service was pretending to do.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
	echo "must run as root"
	exit 1
}

echo "== disabling and removing old system units"
for u in startup gateway litecode wallflower; do
	if systemctl list-unit-files "$u.service" --no-legend 2>/dev/null | grep -q .; then
		echo "  $u.service"
		systemctl disable --now "$u.service" 2>&1 | sed 's/^/    /'
		rm -f "/etc/systemd/system/$u.service"
	else
		echo "  $u.service: not present"
	fi
done

echo
echo "== disabling and removing t3code (user unit)"
if systemctl --user list-unit-files t3code.service --no-legend 2>/dev/null | grep -q . \
	|| [ -f /home/heliodex/.config/systemd/user/t3code.service ]; then
	systemctl --user disable --now t3code.service 2>&1 | sed 's/^/    /' || true
	rm -f /home/heliodex/.config/systemd/user/t3code.service
	rm -f /home/heliodex/.config/systemd/user/default.target.wants/t3code.service
	echo "  removed"
else
	echo "  not present"
fi

echo
echo "== permanent firewall rules"
for p in 80 443; do
	if firewall-cmd --permanent --query-port="$p/tcp" 2>/dev/null | grep -q yes; then
		echo "  $p/tcp already permanent"
	else
		firewall-cmd --permanent --add-port="$p/tcp" 2>&1 | sed 's/^/    /'
	fi
done

# The old STARTUP.sh also opened these two, at runtime only:
#
#   8333/tcp   bitcoin P2P
#   9735/tcp   bitcoin P2P, the pre-0.9 default
#
# They are not added here. lnd reaches bitcoind over the local RPC port, not over P2P, so nothing on this box needs them inbound.
# They are listed here so the decision is explicit rather than a silent omission.
echo
echo "  not adding, but worth deciding on:"
echo "    8333/tcp  bitcoin P2P"
echo "    9735/tcp  bitcoin P2P, the pre-0.9 default"
echo "  lnd talks to bitcoind over local RPC, so neither is needed"
echo "  inbound unless you run a second node that connects to this one."
echo "  If you do want them:"
echo "    firewall-cmd --permanent --add-port=8333/tcp"
echo "    firewall-cmd --permanent --add-port=9735/tcp"

firewall-cmd --reload 2>&1 | sed 's/^/    /'

echo
echo "== the permanent rules now in place"
firewall-cmd --permanent --list-all --zone=public 2>&1 | sed 's/^/  /'

echo
echo "  (the old startup.service used --add-port without --permanent, so"
echo "   these were runtime-only and vanished on every firewalld restart."
echo "   They are now permanent, so a reboot does not take the web server"
echo "   offline.)"

echo
echo "== reloading systemd"
systemctl daemon-reload
systemctl --user daemon-reload 2>/dev/null || true

echo
echo "== done"
echo "  systemctl list-unit-files --state=enabled | grep -E 'surreal|startup|gateway|litecode|wallflower'"
echo "  (should be empty)"
