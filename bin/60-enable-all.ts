#!/usr/bin/env bun
// bin/60-enable-all.ts — enable and start every service in this repo.
//
// Run:  sudo bun bin/60-enable-all.ts
//
// Port of bin/60-enable-all.sh. 30-install.ts installs but deliberately does not enable, so that the first run can be watched one unit at a time. This enables and starts them in dependency order and reports which ones came up.

import { $ } from "bun"
import { root, section } from "./_lib.ts"

root()

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
	"coputer-litecode.service",
	"coputer-gateway@coputer.heliodex.cf.service",
	"coputer-wallflower@coputer.heliodex.cf.service",
	"paper@LHCRJpaper.service",
	"urbit.service",
	"caddy.service",
]

console.log("== enabling and starting ==")

let ok = 0
const failed: string[] = []

/** The last few log lines for a unit, indented. */
async function logs(unit: string, indent = "      "): Promise<void> {
	const r = await $`journalctl -u ${unit} -b --no-pager -n 8`.nothrow().quiet()
	const lines = r.stdout.toString().trimEnd().split("\n").slice(-9)
	for (const l of lines) console.log(`${indent}${l}`)
}

for (const unit of UNITS) {
	console.log(`\n--- ${unit} ---`)

	const enabled = await $`systemctl enable ${unit}`.nothrow().quiet()
	if (enabled.exitCode !== 0) {
		console.log("  !! could not enable")
		failed.push(unit)
		continue
	}
	console.log("  enabled")

	await $`systemctl reset-failed ${unit}`.nothrow().quiet()

	const started = await $`systemctl start ${unit}`.nothrow().quiet()
	if (started.exitCode !== 0) {
		console.log("  !! failed to start")
		await logs(unit)
		failed.push(unit)
		continue
	}

	await Bun.sleep(2000)

	// is-active exits non-zero for anything that is not "active", so read its output and its exit code separately.
	const state = (await $`systemctl is-active ${unit}`.nothrow().quiet()).stdout.toString().trim() || "unknown"
	if (state === "active") {
		console.log("  running")
		ok++
	} else {
		console.log(`  !! state is ${state}`)
		await logs(unit)
		failed.push(unit)
	}
}

section("RESULT")
console.log(`running: ${ok} of ${UNITS.length}`)

if (failed.length > 0) {
	console.log("not running:")
	for (const u of failed) console.log(`  ${u}`)
	console.log("\nfor the details of each:")
	console.log("  journalctl -u <unit> -b -n 50 --no-pager")
	console.log("\nand for the SELinux denials, if any:")
	console.log("  ausearch -m avc -ts boot | tail -20")
}

section("ENABLED AT BOOT")
const enabledList = await $`systemctl list-unit-files --state=enabled --no-legend --no-pager`.nothrow().quiet()
const matching = enabledList.stdout
	.toString()
	.split("\n")
	.filter(l => /radicle|bitcoin|lnd|lnbits|albyhub|peaks|mercury|defector|coputer|paper|urbit|caddy/.test(l))
	.toSorted()

console.log(matching.length > 0 ? matching.map(l => l.trim()).join("\n") : "(none)")

console.log("\n=== DONE ===")
