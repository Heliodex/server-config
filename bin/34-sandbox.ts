#!/usr/bin/env bun
// bin/34-sandbox.ts — build and (re)start the OpenCode + OpenChamber sandbox.
//
// Run as heliodex, not root:  bun bin/34-sandbox.ts
//
// The sandbox is a rootless podman quadlet, so it is a user unit: nothing goes under /etc and no sudo is needed. This links the quadlet from the repo into ~/.config/containers/systemd (the only directory the user quadlet generator reads), builds the image, and restarts the unit.
//
// Runtime state stays in ~/agents, outside the repo: the password file the unit reads, and the projects and OpenCode data the container mounts. The password file is a plaintext secret, so it is never tracked.

import { existsSync, lstatSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { $ } from "bun"
import { exists, REPO, section } from "./_lib.ts"

if (process.getuid?.() === 0) {
	console.error("Run this as the user that owns the sandbox (heliodex), not root: it is a user unit.")
	process.exit(1)
}

const SRC = resolve(REPO, "containers/opencode")
const HOME = homedir()
const QUADLET_DIR = `${HOME}/.config/containers/systemd`
const QUADLET = `${QUADLET_DIR}/opencode.container`
const RUNTIME = `${HOME}/agents`
const ENV_FILE = `${RUNTIME}/opencode.env`

section("CHECKS")

// Without the password file the unit fails to start, so say what to do rather than let systemd report it.
if (!exists(ENV_FILE)) {
	console.error(`${ENV_FILE} is missing.`)
	console.error(`Copy it there from the repo's untracked ${SRC}/opencode.env, then re-run.`)
	console.error("It holds OPENCODE_SERVER_PASSWORD and OPENCHAMBER_UI_PASSWORD, so keep it 0600.")
	process.exit(1)
}

const mode = statSync(ENV_FILE).mode & 0o777
if (mode & 0o077) {
	console.error(`${ENV_FILE} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${ENV_FILE}`)
	process.exit(1)
}
console.log(`  password file present, mode ${mode.toString(8)}`)

// A real file at the quadlet path would be shadowed by the link, and the copy in it would silently stop being used. Refuse rather than overwrite it.
if (existsSync(QUADLET) && !lstatSync(QUADLET).isSymbolicLink()) {
	console.error(`${QUADLET} exists and is not a symlink. Move it aside, then re-run.`)
	process.exit(1)
}

section("LINKING")
await $`install -d -m 0755 ${QUADLET_DIR}`
await $`ln -sfn ${SRC}/opencode.container ${QUADLET}`
console.log(`  ${QUADLET} -> ${SRC}/opencode.container`)

// The bind mounts need their source directories to exist, or podman creates them as root-owned.
for (const dir of ["projects", "state/data", "state/config", "state/openchamber"])
	await $`install -d -m 0755 ${`${RUNTIME}/${dir}`}`

section("BUILDING")
await $`podman build -t opencode-bun -f ${`${SRC}/Containerfile`} ${SRC}`

section("RESTARTING")
await $`systemctl --user daemon-reload`
await $`systemctl --user restart opencode.service`
await Bun.sleep(2000)

const state = (await $`systemctl --user is-active opencode.service`.nothrow().quiet()).stdout.toString().trim()
console.log(`  opencode.service: ${state || "unknown"}`)
if (state !== "active") {
	console.error("  !! not active. Look at: journalctl --user -u opencode.service -n 50 --no-pager")
	process.exit(1)
}

console.log(`
  OpenCode:   http://127.0.0.1:4096
  OpenChamber: http://127.0.0.1:3001
`)
