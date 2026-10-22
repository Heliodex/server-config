#!/usr/bin/env bash
# libexec/mc-stop.sh — stop a PaperMC server cleanly via RCON.
#
# Used as ExecStop= by paper@.service. A hard kill can leave the world half-written, so ask the server to shut itself down first.
#
# The RCON password is read from $CREDENTIALS_DIRECTORY if systemd provided it, and otherwise from a plain 0400 file. The second path exists because the credentials filesystem is not available everywhere on some kernels), and a graceful stop matters more than where the password came from.
set -uo pipefail

RCON_HOST="${MC_RCON_HOST:-127.0.0.1}"
RCON_PORT="${MC_RCON_PORT:-25575}"

PASS_FILE="${CREDENTIALS_DIRECTORY:-}/rcon-password"
if [ ! -r "$PASS_FILE" ]; then
	PASS_FILE="${MC_RCON_PASSWORD_FILE:-/etc/credstore/rcon-password}"
fi
if [ ! -r "$PASS_FILE" ]; then
	echo "mc-stop: no rcon password available" >&2
	exit 0
fi

BUN=/home/heliodex/.bun/bin/bun
if [ ! -x "$BUN" ]; then
	echo "mc-stop: bun not found at $BUN" >&2
	exit 0
fi

if "$BUN" /usr/local/libexec/mc-rcon.js "$RCON_HOST" "$RCON_PORT" "$PASS_FILE" stop; then
	echo "mc-stop: stop command sent"
else
	echo "mc-stop: RCON stop failed; systemd will kill the server" >&2
fi
exit 0
