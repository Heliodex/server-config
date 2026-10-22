#!/usr/bin/env bash
# bin/16-radicle-passphrase.sh — give radicle-node its keystore passphrase.
#
# Run:  sudo bash bin/16-radicle-passphrase.sh
#
# The radicle keystore at ~/.radicle/keys/radicle is an OpenSSH-format key encrypted with bcrypt, so radicle-node needs the passphrase to unlock it at startup. The passphrase goes in a root-owned file that only the unit reads, rather than in the unit file where "systemctl cat" would expose it.
#
# The previous version of this script looked for the keystore under $KEYDIR/radicle and tried to detect whether it was encrypted. It exited early without writing anything, so the unit had nothing to read and the node looped on "keystore is encrypted; a passphrase is required". This version always writes the file and then verifies that the node actually starts with it.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
    echo "must run as root"
    exit 1
}

ENVFILE=/etc/radicle/radicle.env
KEYDIR=/home/heliodex/.radicle/keys
KEYFILE=$KEYDIR/radicle

install -d -m 0755 /etc/radicle

echo "== radicle keystore =="
ls -la "$KEYDIR" 2>&1

if [ ! -f "$KEYFILE" ]; then
    echo "!! no keystore at $KEYFILE" >&2
    exit 1
fi

# The keystore is an OpenSSH-format key. Encrypted ones carry a "bcrypt" KDF marker in the base64 body.
if grep -q 'ENCRYPTED\|bcrypt' "$KEYFILE" 2>/dev/null; then
    echo "  keystore is encrypted, a passphrase is required"
else
    echo "  keystore does not look encrypted, but RAD_PASSPHRASE is harmless"
    echo "  (it will simply be ignored)"
fi

echo
echo "== enter the passphrase you chose during 'rad auth' =="
if [ -t 0 ]; then
    read -r -s -p "passphrase: " PASS
    echo
else
    echo "(no tty, reading from stdin)" >&2
    read -r PASS
fi

if [ -z "${PASS:-}" ]; then
    echo "!! no passphrase given" >&2
    exit 1
fi

umask 077
printf 'RAD_PASSPHRASE=%s\n' "$PASS" >"$ENVFILE"
chown root:root "$ENVFILE"
chmod 0400 "$ENVFILE"

echo
echo "  wrote $ENVFILE (root:root 0400)"

echo
echo "== verifying that the passphrase actually works =="
# Run the node with the passphrase and see whether it gets past the keystore. It listens on 8776, so use a different port to avoid clashing with a running node.
if RAD_HOME=/home/heliodex/.radicle RAD_PASSPHRASE="$PASS" \
    timeout 12 /usr/bin/radicle-node --listen '[::]:18776' --force 2>&1 | head -12; then
    :
fi

echo
echo "  if the output above shows the node past 'Unlocking node keystore',"
echo "  the passphrase is correct. Otherwise it is wrong."
echo
echo "Start the unit with:"
echo "  systemctl start radicle-node.service"
echo "  journalctl -u radicle-node -f"
