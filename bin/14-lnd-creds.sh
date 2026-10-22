#!/usr/bin/env bash
# bin/14-lnd-creds.sh — fix the bitcoind RPC authentication.
#
# Run:  sudo bash bin/14-lnd-creds.sh
#
# WHAT WENT WRONG
# ----------------
# The first version of this script removed rpcuser and rpcpassword from /srv/hdd/.bitcoin/bitcoin.conf, on the reasoning that lnd would get the password from lnd.conf instead. That was wrong on two counts:
#
#   1. In Bitcoin Core, rpcuser and rpcpassword are not "the
#      credentials lnd uses" - they are the credentials bitcoind
#      ACCEPTS. Removing the password left bitcoind with a user
#      whose password it generates at random, so lnd's password was
#      rejected:
#
#        unable to create partial chain control: status code: 401
#
#   2. The password has to live somewhere bitcoind can read it, and
#      /srv/hdd is a fuseblk mount where every file is 0777. So
#      putting it back where it was would put it back in the clear.
#
# THE FIX
# -------
# Split the configuration. bitcoind reads its main config from -conf, so the file it actually uses can live on btrfs with real permissions:
#
#   /etc/bitcoin/bitcoin.conf   0640 root:heliodex
#       server=1, the zmq settings, rpcuser, rpcpassword
#
#   /srv/hdd/.bitcoin/bitcoin.conf   (left without any credentials)
#
# lnd keeps the plaintext in /home/heliodex/.lnd/lnd.conf, mode 0600, which it reads automatically.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
	echo "must run as root"
	exit 1
}

LNDDIR=/home/heliodex/.lnd
LNDCONF=$LNDDIR/lnd.conf
BITCOINCONF=/srv/hdd/.bitcoin/bitcoin.conf
RPCDIR=/etc/bitcoin
RPCCONF=$RPCDIR/bitcoin.conf
CRED_USER=/etc/credstore.encrypted/bitcoin-rpcuser
CRED_PASS=/etc/credstore.encrypted/bitcoin-rpcpass
UNIT=/etc/systemd/system/bitcoind.service

section() {
	echo
	echo "==================== $* ===================="
}

section "THE CREDENTIALS"
for c in "$CRED_USER" "$CRED_PASS"; do
	printf '  %-52s ' "$c"
	[ -f "$c" ] && echo "present" || echo "MISSING"
done
if [ ! -f "$CRED_USER" ] || [ ! -f "$CRED_PASS" ]; then
	echo
	echo "!! the credentials are missing. Run bin/10-secrets.sh first." >&2
	echo "   If the values are wrong, delete and recreate them:" >&2
	echo "     rm $CRED_USER $CRED_PASS" >&2
	echo "     sudo bash bin/10-secrets.sh" >&2
	exit 1
fi

RPCUSER=$(systemd-creds decrypt "$CRED_USER")
RPCPASS=$(systemd-creds decrypt "$CRED_PASS")
[ -n "$RPCUSER" ] && [ -n "$RPCPASS" ] || {
	echo "!! decrypt failed" >&2
	exit 1
}
echo "  decrypted ok"

section "THE CURRENT STATE"
echo "--- $BITCOINCONF ---"
grep -nE '^(rpcuser|rpcpassword|rpcauth|server|zmq|daemon)=' "$BITCOINCONF" 2>&1 \
	| sed 's/^\([0-9]*:\)\(rpcpassword=\).*/\1\2<redacted>/'
echo
echo "--- $LNDCONF ---"
[ -f "$LNDCONF" ] && sed -E 's/^(bitcoind\.rpcpass=).*/\1<redacted>/' "$LNDCONF" || echo "(absent)"
echo
echo "--- the unit's ExecStart ---"
grep -n '^ExecStart=' "$UNIT" 2>&1

section "WRITING $RPCCONF"
# The directory must be traversable by heliodex, because bitcoind runs as User=heliodex and has to read the file. 0750 root:root would stop it at the directory, before the file's own permissions matter.
install -d -m 0755 "$RPCDIR"

# Take the settings that were in the datadir config, and add the credentials. The datadir copy keeps the non-secret settings so nothing is lost if the unit is ever run without -conf.
ZMQ=$(grep -E '^zmqpub(raw)?(block|tx)=' "$BITCOINCONF" 2>/dev/null)

{
	echo "# Written by bin/14-lnd-creds.sh on $(date -Is)"
	echo "#"
	echo "# bitcoind reads this file because the unit passes"
	echo "#   -conf=$RPCCONF"
	echo "#"
	echo "# It lives here rather than in the datadir because /srv/hdd is a"
	echo "# fuseblk mount where every file is 0777. The RPC password"
	echo "# would be world-readable there."
	echo
	echo "server=1"
	[ -n "$ZMQ" ] && echo "$ZMQ"
	echo "rpcuser=$RPCUSER"
	echo "rpcpassword=$RPCPASS"
} >"$RPCCONF"

chown root:heliodex "$RPCCONF"
chmod 0640 "$RPCCONF"

# Fix the directory if an earlier run made it 0750 root:root.
if [ "$(stat -c '%a' "$RPCDIR")" != "755" ]; then
	chmod 0755 "$RPCDIR"
	echo "  fixed the mode on $RPCDIR (was 0750, which stopped heliodex"
	echo "  from even reaching the file)"
fi

echo "  wrote $RPCCONF"
sed -E 's/^(rpcpassword=).*/\1<redacted>/' "$RPCCONF" | sed 's/^/    /'

section "STRIPPING THE CREDENTIALS FROM THE DATADIR CONFIG"
if [ -f "$BITCOINCONF" ]; then
	cp -a "$BITCOINCONF" "$BITCOINCONF.bak.$(date +%s)"
	sed -i '/^rpcuser=/d; /^rpcpassword=/d; /^rpcauth=/d; /^daemon=/d' "$BITCOINCONF"
	echo "  removed rpcuser, rpcpassword and daemon from it"
	echo "--- what is left ---"
	grep -nE '^[a-z]' "$BITCOINCONF" | sed 's/^/    /'
fi

section "POINTING THE UNIT AT $RPCCONF"
if grep -q -- '-conf=' "$UNIT" 2>/dev/null; then
	echo "  the unit already passes -conf"
else
	if [ -f "$UNIT" ]; then
		cp -a "$UNIT" "$UNIT.bak.$(date +%s)"
		sed -i "s#^\(ExecStart=.*bitcoind\)#\1 -conf=$RPCCONF#" "$UNIT"
		echo "  added -conf to the installed unit"
	fi
	# and in the repo, so a reinstall keeps it
	REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
	REPO_UNIT="$REPO_DIR/systemd/system/bitcoind.service"
	if [ -f "$REPO_UNIT" ] && ! grep -q -- '-conf=' "$REPO_UNIT"; then
		sed -i "s#^\(ExecStart=.*bitcoind\)#\1 -conf=$RPCCONF#" "$REPO_UNIT"
		echo "  added -conf to the repo's unit"
	fi
	systemctl daemon-reload
fi
grep -n '^ExecStart=' "$UNIT" 2>&1 | sed 's/^/  /'

section "WRITING lnd.conf"
install -d -m 0700 -o heliodex -g heliodex "$LNDDIR"
[ -f "$LNDCONF" ] && cp -a "$LNDCONF" "$LNDCONF.bak.$(date +%s)"

cat >"$LNDCONF" <<EOF
# Written by bin/14-lnd-creds.sh on $(date -Is)
#
# lnd reads this from its lnddir automatically. Mode 0600, so the
# bitcoind RPC password is not readable by other users.
bitcoind.rpcuser=$RPCUSER
bitcoind.rpcpass=$RPCPASS
EOF
chown heliodex:heliodex "$LNDCONF"
chmod 0600 "$LNDCONF"
echo "  wrote $LNDCONF"
sed -E 's/^(bitcoind\.rpcpass=).*/\1<redacted>/' "$LNDCONF" | sed 's/^/    /'

section "VERIFYING"
echo "--- can the service user reach the config? ---"
# bitcoind runs as heliodex, so it has to be able to traverse the directory AND read the file. Checking only the file misses a directory that is too tight, which is what happened.
printf '  %-46s ' "traverse $RPCDIR"
if su -s /bin/sh heliodex -c "test -x '$RPCDIR'" 2>/dev/null; then
	echo "ok"
else
	echo "BLOCKED - bitcoind cannot reach the file"
	chmod 0755 "$RPCDIR"
	echo "    fixed"
fi
printf '  %-46s ' "read $RPCCONF"
if su -s /bin/sh heliodex -c "test -r '$RPCCONF'" 2>/dev/null; then
	echo "ok"
else
	echo "BLOCKED"
	chown root:heliodex "$RPCCONF"
	chmod 0640 "$RPCCONF"
	echo "    fixed"
fi

echo
echo "--- can bitcoind authenticate with these credentials? ---"
CLI=/home/heliodex/bitcoin/bitcoin-30.0/bin/bitcoin-cli
if [ -x "$CLI" ]; then
	# The config file is read by bitcoind, and bitcoin-cli can be pointed at the same file.
	echo "  (this talks to the running bitcoind, so restart it first if it"
	echo "   was started before this script ran)"
	if "$CLI" -conf="$RPCCONF" -datadir=/srv/hdd/.bitcoin getblockcount 2>&1 | head -2; then
		echo "  (a number above means the RPC auth works)"
	else
		echo "  !! the RPC auth still fails"
	fi
else
	echo "  (bitcoin-cli not found, skipping)"
fi

echo
echo "--- is the password still anywhere in the clear? ---"
for f in "$BITCOINCONF" /usr/sbin/lnd.sh; do
	[ -f "$f" ] || continue
	printf '  %-46s ' "$f"
	grep -qF "$RPCPASS" "$f" 2>/dev/null && echo "STILL CONTAINS IT" || echo "clean"
done
printf '  %-46s ' "$RPCCONF"
grep -qF "$RPCPASS" "$RPCCONF" 2>/dev/null && echo "contains it, mode 0640 root:heliodex" || echo "clean"
printf '  %-46s ' "$LNDCONF"
grep -qF "$RPCPASS" "$LNDCONF" 2>/dev/null && echo "contains it, mode 0600 heliodex" || echo "clean"

cat <<'EOF'

== THEN ==

  systemctl restart bitcoind.service
  systemctl restart lnd.service
  journalctl -u lnd -f

  lnd should now get past "unable to create partial chain control" and
  unlock its wallet.
EOF

echo
echo "=== DONE ==="
