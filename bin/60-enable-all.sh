#!/usr/bin/env bash
# bin/60-enable-all.sh — enable and start every service in this repo.
#
# Run:  sudo bash bin/60-enable-all.sh
#
# 30-install.sh puts the unit files in place but deliberately does not enable them, so that you can start them one at a time and watch each one fail. This enables and starts them all, in dependency order, and reports which ones came up.
#
# Order matters:
#   bitcoind   before lnd, which needs a chain backend
#   lnd        before lnbits and albyhub
#   everything before caddy, which reverse-proxies all of it
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
    echo "must run as root"
    exit 1
}

# unit|reason it matters
UNITS=(
    "radicle-node.service"
    "bitcoind.service"
    "lnd.service"
    "lnbits.service"
    "albyhub.service"
    "radicle-httpd.service"
    "peaks.service"
    "mercury-core.service"
    "defector.service"
    "coputer-litecode.service"
    "coputer-gateway@coputer.heliodex.cf.service"
    "coputer-wallflower@coputer.heliodex.cf.service"
    "paper@LHCRJpaper.service"
    "urbit.service"
    "caddy.service"
)

echo "== enabling and starting =="
ok=0
failed=()

for u in "${UNITS[@]}"; do
    printf '\n--- %s ---\n' "$u"

    if systemctl enable "$u" >/dev/null 2>&1; then
        echo "  enabled"
    else
        echo "  !! could not enable"
        failed+=("$u")
        continue
    fi

    systemctl reset-failed "$u" >/dev/null 2>&1 || true

    if systemctl start "$u" 2>&1 | sed 's/^/    /'; then
        sleep 2
        state=$(systemctl is-active "$u" 2>/dev/null || echo unknown)
        if [ "$state" = "active" ]; then
            echo "  running"
            ok=$((ok + 1))
        else
            echo "  !! state is $state"
            journalctl -u "$u" -b --no-pager -n 8 2>&1 | sed 's/^/      /' | tail -9
            failed+=("$u")
        fi
    else
        echo "  !! failed to start"
        journalctl -u "$u" -b --no-pager -n 8 2>&1 | sed 's/^/      /' | tail -9
        failed+=("$u")
    fi
done

echo
echo "==================== RESULT ===================="
echo "running: $ok of ${#UNITS[@]}"
if [ "${#failed[@]}" -gt 0 ]; then
    echo "not running:"
    for u in "${failed[@]}"; do
        echo "  $u"
    done
    echo
    echo "for the details of each:"
    echo "  journalctl -u <unit> -b -n 50 --no-pager"
    echo
    echo "and for the SELinux denials, if any:"
    echo "  ausearch -m avc -ts boot | tail -20"
fi

echo
echo "==================== ENABLED AT BOOT ===================="
systemctl list-unit-files --state=enabled --no-legend --no-pager 2>&1 \
    | grep -E 'radicle|bitcoin|lnd|lnbits|albyhub|peaks|mercury|defector|coputer|paper|urbit|caddy' \
    | sort || echo "(none)"

echo
echo "=== DONE ==="
