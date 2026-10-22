#!/usr/bin/env bun
// bin/50-retire.ts — remove the old supervisors, make the firewall permanent.
//
// Run:  sudo bun bin/50-retire.ts
//
// Disables and removes startup.service (which only ran four non-permanent firewall-cmd calls), gateway.service, litecode.service, wallflower.service and the unused user unit t3code.service, then installs the firewalld rules that startup.service was pretending to do.

import { $ } from "bun"
import { exists, root } from "./_lib.ts"

root()

const OLD = ["startup", "gateway", "litecode", "wallflower"]

console.log("== disabling and removing old system units")
for (const u of OLD) {
	const unit = `${u}.service`
	const listed = (await $`systemctl list-unit-files ${unit} --no-legend`.nothrow().quiet()).stdout.toString().trim()

	if (listed) {
		console.log(`  ${unit}`)
		await $`systemctl disable --now ${unit}`.nothrow()
		await $`rm -f ${`/etc/systemd/system/${unit}`}`.nothrow()
	} else console.log(`  ${unit}: not present`)
}

console.log("\n== disabling and removing t3code (user unit)")
const t3 = "/home/heliodex/.config/systemd/user/t3code.service"
const t3Listed = (await $`systemctl --user list-unit-files t3code.service --no-legend`.nothrow().quiet()).stdout
	.toString()
	.trim()
if (t3Listed || exists(t3)) {
	await $`systemctl --user disable --now t3code.service`.nothrow()
	await $`rm -f ${t3}`.nothrow()
	await $`rm -f /home/heliodex/.config/systemd/user/default.target.wants/t3code.service`.nothrow()
	console.log("  removed")
} else console.log("  not present")

console.log("\n== permanent firewall rules")
for (const p of [80, 443]) {
	const already = (await $`firewall-cmd --permanent --query-port=${`${p}/tcp`}`.nothrow().quiet()).stdout
		.toString()
		.includes("yes")
	if (already) console.log(`  ${p}/tcp already permanent`)
	else await $`firewall-cmd --permanent --add-port=${`${p}/tcp`}`.nothrow()
}

// The old STARTUP.sh also opened 8333 and 9735 (bitcoin P2P) at runtime.
// lnd reaches bitcoind over the local RPC port, so nothing here needs them inbound. Listed so the decision is explicit rather than a silent omission.
console.log(`
  not adding, but worth deciding on:
    8333/tcp  bitcoin P2P
    9735/tcp  bitcoin P2P, the pre-0.9 default
  lnd talks to bitcoind over local RPC, so neither is needed inbound
  unless you run a second node that connects to this one.
  If you do want them:
    firewall-cmd --permanent --add-port=8333/tcp
    firewall-cmd --permanent --add-port=9735/tcp
`)

await $`firewall-cmd --reload`.nothrow()

console.log("== the permanent rules now in place")
await $`firewall-cmd --permanent --list-all --zone=public`.nothrow()

console.log(`
  (the old startup.service used --add-port without --permanent, so those
   were runtime-only and vanished on every firewalld restart. They are now
   permanent, so a reboot does not take the web server offline.)

== reloading systemd
`)

await $`systemctl daemon-reload`.nothrow()
await $`systemctl --user daemon-reload`.nothrow()

console.log(`
== done

  systemctl list-unit-files --state=enabled | grep -E 'surreal|startup|gateway|litecode|wallflower'
  (should be empty)
`)
