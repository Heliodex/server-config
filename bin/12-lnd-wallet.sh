#!/usr/bin/env bash
# bin/12-lnd-wallet.sh — place the LND wallet password where lnd expects it.
#
# Run:  bash bin/12-lnd-wallet.sh
#
# lnd's --wallet-unlock-password-file expects a plain file on disk, owned by the lnd user, mode 0400. This reads the systemd credential and writes that file. Re-run it if the credential is ever rotated.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
	echo "must run as root"
	exit 1
}

CRED=/etc/credstore.encrypted/lnd-wallet-pass
TARGET=/home/heliodex/.lnd/wallet-password

if [ ! -f "$CRED" ]; then
	echo "no credential at $CRED - run bin/10-secrets.sh first"
	exit 1
fi

if [ -f "$TARGET" ] && [ "$TARGET" -nt "$CRED" ]; then
	echo "$TARGET is already newer than the credential; leaving it alone"
	exit 0
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# The credential's embedded name, its filename and the ID used in the unit are all the same string, so no --name= override is needed here.
if ! systemd-creds decrypt "$CRED" >"$tmp"; then
	echo "decrypt failed" >&2
	exit 1
fi

if [ ! -s "$tmp" ]; then
	echo "decrypted credential is empty" >&2
	exit 1
fi

install -o heliodex -g heliodex -m 0400 "$tmp" "$TARGET"
echo "wrote $TARGET (heliodex:heliodex 0400)"
echo
echo "lnd.service points at it with:"
echo "  --wallet-unlock-password-file=$TARGET"
