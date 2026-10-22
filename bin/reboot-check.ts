#!/usr/bin/env bun
// bin/reboot-check.ts — did the box come back whole?
//
// Run:  sudo bun bin/reboot-check.ts
// Out:  out/reboot-check.txt, and the same text on the terminal
//
// Port of bin/reboot-check.sh. It waits for the boot to finish before judging anything, because a check that runs mid-boot reports every service that has not started yet as broken.
//
// A service can be active and still be broken, so this checks behaviour:
// that each one is listening rather than merely running, that lnd's wallet unlocked, that caddy obtained certificates, that /srv/hdd is mounted, and that the firewall rules and the SELinux boolean survived.

import { $ } from "bun"
import { exists, REPO, root } from "./_lib.ts"

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
	"coputer-gateway@coputer.heliodex.cf.service",
	"coputer-wallflower@coputer.heliodex.cf.service",
	"coputer-litecode.service",
	"paper@LHCRJpaper.service",
	"urbit.service",
	"caddy.service",
]

const out: string[] = []
const log = (line = "") => {
	out.push(line)
	console.log(line)
}
const section = (title: string) => log(`\n==================== ${title} ====================`)

let problems = 0

const stateOf = async (unit: string) =>
	(await $`systemctl is-active ${unit}`.nothrow().quiet()).stdout.toString().trim() || "unknown"

section("WAITING FOR THE BOOT TO FINISH")
log(`  the box is still starting services; waiting up to 10 minutes.
  bitcoind and lnd are the slow ones: bitcoind verifies the chain and lnd
  waits for it, so a cold boot takes a while.`)

let waited = 0
while (waited < 600) {
	const st = (await $`systemctl is-system-running`.nothrow().quiet()).stdout.toString().trim()
	// "starting" is the only state worth waiting on. "degraded" means something failed and waiting will not help.
	if (st !== "starting" && st !== "") {
		log(`\n  system state: ${st} (after ${waited}s)`)
		break
	}
	if (waited > 0 && waited % 30 === 0) {
		const jobs = (await $`systemctl list-jobs --no-legend --no-pager`.nothrow().quiet()).stdout.toString()
		log(`  ${waited}s: ${jobs.split("\n").filter(Boolean).length} jobs still queued`)
	}
	await Bun.sleep(5000)
	waited += 5
}

if (waited >= 600) {
	log("\n  !! still starting after 10 minutes.")
	log("  --- what is still running ---")
	const jobs = await $`systemctl list-jobs --no-pager`.nothrow().quiet()
	log(jobs.stdout.toString().trimEnd().replaceAll(/^/gm, "    "))
}

log("\n--- the ones that take longest, and whether they made it ---")
for (const unit of ["bitcoind.service", "lnd.service"]) {
	let state = await stateOf(unit)
	let secs = 0
	while (secs < 300 && state !== "active" && state !== "failed") {
		await Bun.sleep(5000)
		secs += 5
		state = await stateOf(unit)
	}
	log(`  ${unit.padEnd(24)} ${state} (waited ${secs}s)`)
}

section("BOOT")
log((await $`uptime`.nothrow().quiet()).stdout.toString().trimEnd().replaceAll(/^/gm, "  "))
log(
	(await $`systemd-analyze`.nothrow().quiet()).stdout
		.toString()
		.trimEnd()
		.split("\n")
		.slice(0, 4)
		.join("\n")
		.replaceAll(/^/gm, "  "),
)

section("EVERY UNIT: ENABLED AND ACTIVE")
log(`${"UNIT".padEnd(48)} ${"ACTIVE".padEnd(12)} ${"ENABLED".padEnd(10)} RESTARTS`)

const notActive: string[] = []
for (const unit of UNITS) {
	const active = await stateOf(unit)
	const enabled = (await $`systemctl is-enabled ${unit}`.nothrow().quiet()).stdout.toString().trim() || "unknown"
	const restarts = (await $`systemctl show ${unit} -p NRestarts --value`.nothrow().quiet()).stdout.toString().trim()

	log(`${unit.padEnd(48)} ${active.padEnd(12)} ${enabled.padEnd(10)} ${restarts}`)
	if (active !== "active") {
		notActive.push(unit)
		problems++
	}
	if (enabled !== "enabled" && enabled !== "enabled-runtime") log("      ^^ NOT ENABLED, so it will not start at boot")
	if (restarts && restarts !== "0") log(`      ^^ restarted ${restarts} time(s)`)
}

if (notActive.length > 0) {
	log("\n--- why the ones that are not active are not ---")
	for (const unit of notActive) {
		log(`\n  ########## ${unit} ##########`)
		const show = await $`systemctl show ${unit} -p ActiveState -p SubState -p Result -p ExecMainStatus --no-pager`
			.nothrow()
			.quiet()
		log(show.stdout.toString().trimEnd().replaceAll(/^/gm, "    "))
		const j = await $`journalctl -u ${unit} -b --no-pager -n 8`.nothrow().quiet()
		log(
			j.stdout
				.toString()
				.trimEnd()
				.split("\n")
				.slice(-9)
				.map(l => `    ${l}`)
				.join("\n"),
		)
	}
}

section("FAILED UNITS")
const failed = (await $`systemctl --failed --no-legend --no-pager`.nothrow().quiet()).stdout.toString().trim()
if (failed) {
	log(failed.replaceAll(/^/gm, "  "))
	problems++
} else log("  (none)")

section("THE PORTS ARE ACTUALLY LISTENING")
const sockets = (await $`ss -tln`.nothrow().quiet()).stdout.toString()
const checkPort = (port: number, what: string) => {
	const listening = new RegExp(`:${port}\\s`).test(sockets)
	log(`  ${String(port).padEnd(8)} ${what.padEnd(30)} ${listening ? "listening" : "NOT LISTENING"}`)
	if (!listening) problems++
}

checkPort(443, "caddy https")
checkPort(5000, "lnbits")
checkPort(6511, "peaks")
checkPort(3000, "defector")
checkPort(10009, "lnd grpc")
checkPort(18080, "lnd rest")
checkPort(8080, "urbit http")
checkPort(8775, "radicle-httpd")
checkPort(8776, "radicle-node")
checkPort(8332, "bitcoind rpc")

section("THE SERVICES ARE TALKING TO EACH OTHER")
log("--- lnd's wallet, which is the thing that used to be locked ---")
const lndLog = (await $`journalctl -u lnd -b --no-pager`.nothrow().quiet()).stdout.toString()
log(
	lndLog
		.split("\n")
		.filter(l => /wallet.*unlock|wallet.*locked|unlocked wallet|Waiting for wallet/i.test(l))
		.slice(-3)
		.join("\n") || "  (nothing)",
)

log("\n--- lnbits reached lnd ---")
const lnbitsLog = (await $`journalctl -u lnbits -b --no-pager`.nothrow().quiet()).stdout.toString()
if (/LndWallet|wallet.*(ok|ready|connected)/i.test(lnbitsLog)) log("  lnbits is using the LndWallet backend")
else
	log(
		lnbitsLog
			.split("\n")
			.filter(l => /error|wallet|backend/i.test(l))
			.slice(-5)
			.join("\n") || "  (no explicit confirmation)",
	)

log("\n--- caddy: certificates and any errors ---")
log("  certificates on disk:")
const certDir = "/var/lib/caddy/.local/share/caddy/certificates"
const certs = (await $`ls -1 ${certDir}`.nothrow().quiet()).stdout.toString().trim()
log(
	certs
		? certs
				.split("\n")
				.slice(0, 8)
				.map(l => `    ${l}`)
				.join("\n")
		: "    (none)",
)
log("\n  errors since boot (certificates are cached, so 'obtained' is")
log("  usually 0 on a reboot - what matters is that nothing failed):")
const caddyLog = (await $`journalctl -u caddy -b --no-pager`.nothrow().quiet()).stdout.toString()
const caddyErrors = caddyLog
	.split("\n")
	.filter(l => l.includes('"level":"error"'))
	.slice(-6)
log(caddyErrors.length > 0 ? caddyErrors.map(l => `    ${l}`).join("\n") : "    (none)")

section("THE DATA DISKS")
log((await $`df -h / /srv /srv/hdd`.nothrow().quiet()).stdout.toString().trimEnd().replaceAll(/^/gm, "  "))

const mounted = (await $`findmnt /srv/hdd`.nothrow().quiet()).exitCode === 0
log(`\n  ${"/srv/hdd mounted".padEnd(46)} ${mounted ? "yes" : "NO - bitcoind and lnd would fail without it"}`)
if (!mounted) problems++

const fstab = exists("/etc/fstab") ? await Bun.file("/etc/fstab").text() : ""
const inFstab = /[ \t]\/srv\/hdd[ \t]/.test(fstab)
log(`  ${"/srv/hdd in fstab".padEnd(46)} ${inFstab ? "yes" : "NOT IN FSTAB"}`)
if (!inFstab) problems++

const pcent =
	(await $`df --output=pcent /`.nothrow().quiet()).stdout.toString().trim().split("\n").at(-1)?.replaceAll(/\D/g, "")
	?? ""
if (pcent && Number(pcent) >= 90) {
	log(`\n  !! / is ${pcent}% full. Not caused by this migration, but a full`)
	log("     root filesystem breaks services in confusing ways. Worth clearing.")
}

section("THE FIREWALL")
const fwActive = (await $`systemctl is-active firewalld`.nothrow().quiet()).stdout.toString().trim() === "active"
if (!fwActive) {
	log("  !! firewalld is NOT RUNNING")
	log("     That means no filtering at all right now, whatever the permanent")
	log("     configuration says.")
	problems++
} else {
	log("  firewalld: running")
	log("\n  --- the zone in force ---")
	log(
		(await $`firewall-cmd --get-active-zones`.nothrow().quiet()).stdout.toString().trimEnd().replaceAll(/^/gm, "    "),
	)
	log("\n  --- open ports ---")
	const portsOpen = (await $`firewall-cmd --list-ports`.nothrow().quiet()).stdout.toString().trim()
	log(portsOpen.split(/\s+/).filter(Boolean).join("\n").replaceAll(/^/gm, "    "))
	log("\n  --- are 80 and 443 open permanently? ---")
	for (const p of [80, 443]) {
		const yes = (await $`firewall-cmd --permanent --query-port=${`${p}/tcp`}`.nothrow().quiet()).exitCode === 0
		log(`    ${String(p).padEnd(6)} ${yes ? "yes" : "NO"}`)
		if (!yes) problems++
	}
}

section("SELINUX")
if ((await $`command -v ausearch`.nothrow().quiet()).exitCode === 0) {
	const avcs = (await $`ausearch -m avc -ts boot`.nothrow().quiet()).stdout.toString()
	const denied = avcs.split("\n").filter(l => l.includes("denied"))
	log(`  denials this boot: ${denied.length}`)
	if (denied.length > 0)
		log(
			denied
				.slice(-8)
				.map(l => `    ${l}`)
				.join("\n"),
		)
} else log("  ausearch is not installed: zypper install policycoreutils-python-utils")

const bool = (await $`getsebool httpd_can_network_connect`.nothrow().quiet()).stdout
	.toString()
	.trim()
	.split("-->")[1]
	?.trim()
log(`\n  ${"httpd_can_network_connect".padEnd(46)} ${bool ?? "unknown"}`)
log("  (must be on, or caddy cannot renew certificates)")

section("SUMMARY")
if (problems === 0) {
	log("  everything is up, enabled and listening.")
	log("\n  The box came back whole.")
} else {
	log(`  ${problems} item(s) worth looking at, listed above.`)
	log("\n  Some of these are consequences of one cause: if lnd is not active,")
	log("  lnbits and albyhub cannot be either, because both were started with")
	log("  Wants= on lnd.service.")
}
log("\n  Details of any unit:")
log("    journalctl -u <unit> -b -n 50 --no-pager")

const dir = `${REPO}/out`
if (!exists(dir)) await $`mkdir -p ${dir}`.nothrow()
await Bun.write(`${dir}/reboot-check.txt`, `${out.join("\n")}\n`)

console.log("\n=== DONE ===")
