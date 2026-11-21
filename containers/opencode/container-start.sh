#!/usr/bin/env bash
# Container entrypoint: run the OpenCode server and the OpenChamber web UI side by side.
#
# OpenChamber normally manages its own OpenCode server, but here the sandbox already runs one, so we start OpenCode ourselves and point OpenChamber at it with OPENCODE_SKIP_START. Both processes share this container's filesystem, so OpenChamber's projects, Git, terminal and preview features see the same /workspace as OpenCode.
set -uo pipefail

OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCHAMBER_PORT="${OPENCHAMBER_PORT:-3000}"
OPENCHAMBER_HOST="${OPENCHAMBER_HOST:-0.0.0.0}"

opencode serve --hostname 0.0.0.0 --port "$OPENCODE_PORT" &
opencode_pid=$!

# Wait for the API to accept connections before bringing up the UI, so it does not flash "OpenCode is restarting" on every start. Any HTTP response is enough - a 401 from the password gate still means the server is listening.
for _ in $(seq 1 120); do
	if curl -s -o /dev/null "http://127.0.0.1:${OPENCODE_PORT}/"; then
		break
	fi
	if ! kill -0 "$opencode_pid" 2>/dev/null; then
		echo "opencode exited during startup" >&2
		exit 1
	fi
	sleep 0.5
done

# Reuse the server above instead of letting OpenChamber start its own.
# OPENCODE_SERVER_PASSWORD (from the environment file) is how OpenChamber authenticates to it.
export OPENCODE_HOST="http://127.0.0.1:${OPENCODE_PORT}"
export OPENCODE_SKIP_START=true
export OPENCHAMBER_TERMINAL_SHELL="${OPENCHAMBER_TERMINAL_SHELL:-/usr/bin/bash}"

openchamber serve --foreground --host "$OPENCHAMBER_HOST" --port "$OPENCHAMBER_PORT" &
openchamber_pid=$!

shutdown() {
	kill -TERM "$openchamber_pid" "$opencode_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# If either process dies, take the container down and let the restart policy bring the pair back up.
wait -n "$openchamber_pid" "$opencode_pid"
status=$?
shutdown
wait 2>/dev/null || true
exit "$status"
