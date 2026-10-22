#!/usr/bin/env bash
# bin/10-secrets.sh — create systemd credentials for the services that need them, and move the plaintext out of /usr/sbin and the Caddyfile.
#
# Run:  bash bin/10-secrets.sh
#
# Creates /etc/credstore.encrypted/<name> (encrypted, host-bound).
#
# NAMING RULE, which systemd-creds enforces
# ------------------------------------------
# systemd-creds embeds a name inside the ciphertext, and on decrypt it compares that embedded name against an EXPECTED name. What counts as "expected" depends on who is decrypting:
#
#   * systemd-creds decrypt FILE
#       expected = the BASENAME of FILE, including any extension.
#       ("lnd-wallet-pass.cred" -> expects "lnd-wallet-pass.cred")
#
#   * LoadCredentialEncrypted=ID:/path
#       expected = ID, the name before the colon.
#
# The two disagree about extensions, so the simplest way to satisfy both is to make the embedded name, the filename, and the unit's ID all identical.
# That means:
#
#   * the file is named WITHOUT a .cred suffix
#     (/etc/credstore.encrypted/lnd-wallet-pass)
#   * the embedded name is the same string
#   * the unit says:
#       LoadCredentialEncrypted=lnd-wallet-pass:/etc/credstore.encrypted/lnd-wallet-pass
#
# systemd's own encrypted store uses exactly this convention: one file per credential, named as the credential, no extension.
#
# Why /etc/credstore.encrypted/ and not /etc/credstore/:
# /etc/credstore/ is the TRUSTED store, whose contents are handed to services as plaintext. An encrypted blob there would be passed out as raw base64 to anything globbing that directory.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
	echo "must run as root"
	exit 1
}

CREDSTORE=/etc/credstore.encrypted
install -d -m 0700 "$CREDSTORE"

echo "== TPM2 present?"
if systemd-creds --tpm2-device=list 2>/dev/null | grep -q /dev/tpm; then
	KEY=tpm2
	echo "  -> credentials will be TPM2-bound (decryptable only on this machine)"
else
	KEY=host
	echo "  -> no TPM2; credentials bound to /var/lib/systemd/credential.secret"
	echo "     BACK THAT FILE UP or the credentials become unreadable:"
	echo "     sudo cp -a /var/lib/systemd/credential.secret ~/credential.secret.bak"
fi

# Migrate a credential created by an older version of this script:
#   /etc/credstore/<name>.cred  (embedded name "<name>", wrong dir, has ext)
#     -> /etc/credstore.encrypted/<name>  (embedded name "<name>")
migrate() {
	local name="$1"
	local old_cred="/etc/credstore/$name.cred"
	local old_plain="/etc/credstore/$name"
	local new="$CREDSTORE/$name"
	local src=""

	[ -f "$old_cred" ] && src="$old_cred"
	[ -f "$old_plain" ] && src="$old_plain"
	[ -n "$src" ] || return 1

	echo "  $name: migrating $src"
	local tmp
	tmp=$(mktemp)
	if systemd-creds decrypt --name="$name" "$src" >"$tmp" 2>/dev/null; then
		if systemd-creds encrypt --name="$name" --with-key="$KEY" "$tmp" "$new" 2>/dev/null; then
			chmod 0600 "$new"
			rm -f "$src" "$src.cred"
			echo "  $name: migrated to $new"
			rm -f "$tmp"
			return 0
		fi
	fi
	rm -f "$tmp"
	echo "  $name: could not migrate $src, re-asking" >&2
	return 1
}

create_cred() {
	local name="$1" prompt="$2"
	local file="$CREDSTORE/$name"

	if [ -f "$file" ]; then
		echo "  $name: already exists, leaving alone"
		return 0
	fi

	if migrate "$name"; then
		return 0
	fi

	echo "  $name: $prompt"
	if ! systemd-ask-password "$prompt" \
		| systemd-creds encrypt --name="$name" --with-key="$KEY" - "$file"; then
		echo "  $name: FAILED" >&2
		return 1
	fi
	chmod 0600 "$file"
	echo "  $name: written to $file"
}

echo
echo "== creating credentials"
create_cred lnd-wallet-pass "LND wallet unlock password: "
create_cred bitcoin-rpcuser "bitcoind RPC username [Heliodex]: "
create_cred bitcoin-rpcpass "bitcoind RPC password: "
create_cred rcon-password "PaperMC RCON password (set enable-rcon=true in server.properties): "

echo
echo "== verifying each credential round-trips"
for f in "$CREDSTORE"/*; do
	[ -f "$f" ] || continue
	base=$(basename "$f")
	if systemd-creds decrypt "$f" >/dev/null 2>&1; then
		printf '  %-28s ok\n' "$base"
	else
		printf '  %-28s FAILED (name mismatch or bad key)\n' "$base"
	fi
done

# systemd mounts a tmpfs for the credentials directory, and that needs a recent kernel. If that mount is unavailable, every unit using LoadCredential= fails with 243/CREDENTIALS.
#
# The RCON password is needed for a graceful PaperMC shutdown, so also write it out as a plain 0400 file the service user can read. That way the shutdown works even when the credentials filesystem is not.
echo
echo "== writing the plain-text fallback for the RCON password"
if [ -f "$CREDSTORE/rcon-password" ]; then
	tmp=$(mktemp)
	if systemd-creds decrypt "$CREDSTORE/rcon-password" >"$tmp" 2>/dev/null; then
		install -o heliodex -g heliodex -m 0400 "$tmp" /etc/credstore/rcon-password
		echo "  wrote /etc/credstore/rcon-password (heliodex:heliodex 0400)"
	else
		echo "  could not decrypt rcon-password, skipping" >&2
	fi
	rm -f "$tmp"
else
	echo "  no rcon-password credential, skipping"
fi

# The Netlify token is NOT a systemd credential. Caddy reads the Caddyfile as the caddy user, and 'dns netlify <token>' needs a literal in the config, so the token lives in a root:caddy 0640 file that the unit passes in via EnvironmentFile. See bin/20-caddy.sh.
echo
echo "== the Netlify token is handled by bin/20-caddy.sh, not here."
echo "   It lives in /etc/caddy/netlify.token (root:caddy 0640) and is"
echo "   passed to Caddy as NETLIFY_API_TOKEN via EnvironmentFile."

cat <<'EOF'

== the bitcoind RPC password currently lives in two plaintext places:
   /usr/sbin/lnd.sh            (on the lnd command line)
   /srv/hdd/.bitcoin/bitcoin.conf

Move it into lnd.conf, which lnd reads automatically:

  1. read the existing value:
     sudo grep rpcpassword /srv/hdd/.bitcoin/bitcoin.conf

  2. write /home/heliodex/.lnd/lnd.conf:
       bitcoind.rpcuser=Heliodex
       bitcoind.rpcpass=<same value>
       bitcoind.rpccert=/home/heliodex/.lnd/bitcoin.cert

  3. then:
       sudo chown heliodex:heliodex /home/heliodex/.lnd/lnd.conf
       sudo chmod 600 /home/heliodex/.lnd/lnd.conf
       sudo sed -i '/^rpcpassword=/d' /srv/hdd/.bitcoin/bitcoin.conf

  4. and remove the credentials from /usr/sbin/lnd.sh, which is replaced
     by lnd.service in this repo.

== the LND wallet password

  lnd needs it at a fixed path for --wallet-unlock-password-file:

     sudo bash bin/12-lnd-wallet.sh

== done
EOF
