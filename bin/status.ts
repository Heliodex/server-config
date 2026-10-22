#!/usr/bin/env bun
// bin/status.ts — what is actually running, and what is enabled?
//
// Run:  bun bin/status.ts
// Out:  out/status.txt, and the same text on the terminal
//
// The units are installed and enabled separately, so this distinguishes "the unit file exists" from "the unit is on".

import { $ } from "bun"
import { exists, REPO } from "./_lib.ts"

const UNITS = [
	"radicle-node.service",
	"bitcoind.service",
	"lnd.service",
	"lnbits.service",
	"albyhub.service",
	"radicle-httpd.service",
	"peaks.service",
	"mercury-core.service",
	"defector.service",
	"coputer-gateway@coputer.heliodex.cf.service",
	"coputer-wallflower@coputer.heliodex.cf.service",
	"coputer-litecode.service",
	"paper@LHCRJpaper.service",
	"urbit.service",
	"caddy.service",
]

// Everything goes to the file and to the terminal. The shell version redirected stdout into the file and printed nothing.
const out: string[] = []
const log = (line = "") => {
	out.push(line)
	console.log(line)
}

/** section title, in the same shape the shell scripts use */
const section = (title: string) => log(`\n==================== ${title} ====================`)

/** systemctl is-active exits non-zero for anything not "active", so the
 *  output and the exit code have to be read separately. Appending a
 *  fallback with `||` produced a second line and shifted the table. */
const stateOf = async (unit: string) =>
	(await $`systemctl is-active ${unit}`.nothrow().quiet()).stdout.toString().trim() || "n/a"

const enabledOf = async (unit: string) =>
	(await $`systemctl is-enabled ${unit}`.nothrow().quiet()).stdout.toString().trim() || "n/a"

log(`# server status at ${new Date().toISOString()}`)

section("SUMMARY")
log(`${"UNIT".padEnd(48)} ${"ACTIVE".padEnd(12)} ${"ENABLED".padEnd(12)} RESTARTS`)

for (const unit of UNITS) {
	const active = await stateOf(unit)
	const enabled = await enabledOf(unit)
	const restarts =
		(await $`systemctl show ${unit} -p NRestarts --value`.nothrow().quiet()).stdout.toString().trim() || "?"
	log(`${unit.padEnd(48)} ${active.padEnd(12)} ${enabled.padEnd(12)} ${restarts}`)
}

section("FAILED UNITS")
const failed = (await $`systemctl --failed --no-legend --no-pager`.nothrow().quiet()).stdout.toString().trim()
log(failed || "(none)")

section("ENABLED AT BOOT")
const unitFiles = (
	await $`systemctl list-unit-files --state=enabled --no-legend --no-pager`.nothrow().quiet()
).stdout.toString()
const ours = unitFiles
	.split("\n")
	.filter(l => /radicle|bitcoin|lnd|lnbits|albyhub|peaks|mercury|defector|coputer|paper|urbit|caddy|surreal/.test(l))
log(ours.length > 0 ? ours.join("\n") : "(none of our units are enabled)")

log("\n--- and the multi-user.target wants directory ---")
const wantsDir = (await $`ls -la /etc/systemd/system/multi-user.target.wants/`.nothrow().quiet()).stdout.toString()
const wants = wantsDir
	.split("\n")
	.filter(l => /radicle|bitcoin|lnd|lnbits|albyhub|peaks|mercury|defector|coputer|paper|urbit|caddy/.test(l))
log(wants.length > 0 ? wants.join("\n") : "(none)")

section("PER-UNIT DETAIL")
for (const unit of UNITS) {
	log(`\n########## ${unit} ##########`)

	const show =
		await $`systemctl show ${unit} -p LoadState -p ActiveState -p SubState -p UnitFileState -p NRestarts -p Result -p ExecMainStatus -p ExecMainCode -p User -p FragmentPath -p ConditionResult --no-pager`
			.nothrow()
			.quiet()
	log(show.stdout.toString().trimEnd().replaceAll(/^/gm, "  "))

	log("  --- last 8 log lines ---")
	const journal = await $`journalctl -u ${unit} -b --no-pager -n 8`.nothrow().quiet()
	const lines = journal.stdout.toString().trimEnd().split("\n").slice(-10)
	log(lines.map(l => `  ${l}`).join("\n"))
}

section("BOOT SUMMARY")
const analyze = await $`systemd-analyze`.nothrow().quiet()
log(analyze.stdout.toString().trimEnd().replaceAll(/^/gm, "  "))

log("\n--- units that failed during this boot ---")
const bootErrors = await $`journalctl -b -p err --no-pager`.nothrow().quiet()
const errs = bootErrors.stdout
	.toString()
	.split("\n")
	.filter(l => /Failed|failed|error/.test(l))
	.slice(-20)
log(errs.length > 0 ? errs.join("\n") : "(none)")

section("SELINUX DENIALS")
if ((await $`command -v ausearch`.nothrow().quiet()).exitCode === 0) {
	const avcs = await $`ausearch -m avc -ts boot`.nothrow().quiet()
	const denied = avcs.stdout
		.toString()
		.split("\n")
		.filter(l => l.includes("denied"))
		.slice(-15)
	log(denied.length > 0 ? denied.join("\n") : "(none)")
} else log("(ausearch not installed)")

section("LISTENING PORTS")
const ports = await $`ss -tlnp`.nothrow().quiet()
log(ports.stdout.toString().trimEnd().replaceAll(/^/gm, "  "))

section("DISK")
const df = await $`df -h / /srv/hdd`.nothrow().quiet()
log(df.stdout.toString().trimEnd().replaceAll(/^/gm, "  "))
const free = await $`free -h`.nothrow().quiet()
log(free.stdout.toString().trimEnd().replaceAll(/^/gm, "  "))

section("WHAT TO DO NEXT")
log(`If the summary shows "disabled" for most units, that is the
installer's doing: it puts the unit files in place but does not enable
them. To start and enable them all:

  sudo bun bin/60-enable-all.ts

To look at one service in detail:

  systemctl status <unit>
  journalctl -u <unit> -b -n 50 --no-pager`)

const dir = `${REPO}/out`
if (!exists(dir)) await $`mkdir -p ${dir}`.nothrow()
await Bun.write(`${dir}/status.txt`, `${out.join("\n")}\n`)

console.log("\n=== DONE ===")
