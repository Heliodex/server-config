#!/usr/bin/env bun
// Container entrypoint: run the OpenCode server and the OpenChamber web UI side by side.
//
// OpenChamber normally manages its own OpenCode server, but here the sandbox already runs one, so we start OpenCode ourselves and point OpenChamber at it with OPENCODE_SKIP_START. Both processes share this container's filesystem, so OpenChamber's projects, Git, terminal and preview features see the same /workspace as OpenCode.

import { constants } from "node:os"
import type { Subprocess } from "bun"

const OPENCODE_PORT = Bun.env.OPENCODE_PORT ?? "4096"
const OPENCHAMBER_PORT = Bun.env.OPENCHAMBER_PORT ?? "3000"
const OPENCHAMBER_HOST = Bun.env.OPENCHAMBER_HOST ?? "0.0.0.0"

const opencode = Bun.spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", OPENCODE_PORT], {
	stderr: "inherit",
	stdin: "ignore",
	stdout: "inherit",
})

/** Any HTTP response counts, so a 401 from the password gate still means the server is listening. */
async function apiUp(): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/`)
		await res.body?.cancel()
		return true
	} catch {
		return false
	}
}

// Wait for the API to accept connections before bringing up the UI, so it does not flash "OpenCode is restarting" on every start.
for (let attempt = 0; attempt < 120; attempt++) {
	if (await apiUp()) break
	if (opencode.exitCode !== null) {
		console.error("opencode exited during startup")
		process.exit(1)
	}
	await Bun.sleep(500)
}

// Reuse the server above instead of letting OpenChamber start its own.
// OPENCODE_SERVER_PASSWORD (from the environment file) is how OpenChamber authenticates to it.
const openchamber = Bun.spawn(
	["openchamber", "serve", "--foreground", "--host", OPENCHAMBER_HOST, "--port", OPENCHAMBER_PORT],
	{
		env: {
			...Bun.env,
			OPENCHAMBER_TERMINAL_SHELL: Bun.env.OPENCHAMBER_TERMINAL_SHELL ?? "/usr/bin/bash",
			OPENCODE_HOST: `http://127.0.0.1:${OPENCODE_PORT}`,
			OPENCODE_SKIP_START: "true",
		},
		stderr: "inherit",
		stdin: "ignore",
		stdout: "inherit",
	},
)

const children: Subprocess[] = [opencode, openchamber]

// Killing a child that has already exited does nothing, so this is safe to call from either path.
function shutdown(): void {
	for (const child of children) child.kill("SIGTERM")
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

/** The exit code of a child, or 128 + the signal number for one that was killed, as a shell reports it. */
function statusOf(child: Subprocess): number {
	if (child.exitCode !== null) return child.exitCode
	const signal = child.signalCode
	if (typeof signal === "number") return 128 + signal
	if (signal) return 128 + (constants.signals[signal] ?? 0)
	return 1
}

// If either process dies, take the container down and let the restart policy bring the pair back up.
const first = await Promise.race(
	children.map(async child => {
		await child.exited
		return child
	}),
)
const status = statusOf(first)
shutdown()
await Promise.allSettled(children.map(child => child.exited))
process.exit(status)
