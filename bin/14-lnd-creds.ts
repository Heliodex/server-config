#!/usr/bin/env bun
// bin/14-lnd-creds.ts — move the bitcoind RPC password out of plaintext.
//
// Run:  sudo bun bin/14-lnd-creds.ts
//
// Port of bin/14-lnd-creds.sh. The password lives in two readable places: /srv/hdd/.bitcoin/bitcoin.conf on a fuseblk mount where every file is 0777, and on the command line in /usr/sbin/lnd.sh. This moves it to /etc/bitcoin/bitcoin.conf (0640 root:heliodex, on btrfs) which bitcoind reads via -conf, and to ~/.lnd/lnd.conf (0600) which lnd reads automatically.

import { $ } from "bun"
import { exists, label, REPO, root, section } from "./_lib.ts"

root()

const LNDDIR = "/home/heliodex/.lnd"
const LNDCONF = `${LNDDIR}/lnd.conf`
const BITCOINCONF = "/srv/hdd/.bitcoin/bitcoin.conf"
const RPCDIR = "/etc/bitcoin"
const RPCCONF = `${RPCDIR}/bitcoin.conf`
const CRED_USER = "/etc/credstore.encrypted/bitcoin-rpcuser"
const CRED_PASS = "/etc/credstore.encrypted/bitcoin-rpcpass"
const UNIT = "/etc/systemd/system/bitcoind.service"

section("THE CREDENTIALS")
for (const c of [CRED_USER, CRED_PASS]) console.log(`  ${label(c)} ${exists(c) ? "present" : "MISSING"}`)

if (!exists(CRED_USER) || !exists(CRED_PASS)) {
	console.error("\n!! the credentials are missing. Run bin/10-secrets.ts first.")
	console.error("   If the values are wrong, delete and recreate them:")
	console.error(`     rm ${CRED_USER} ${CRED_PASS}`)
	console.error("     sudo bun bin/10-secrets.ts")
	process.exit(1)
}

const RPCUSER = (await $`systemd-creds decrypt ${CRED_USER}`.text()).trim()
const RPCPASS = (await $`systemd-creds decrypt ${CRED_PASS}`.text()).trim()
if (!RPCUSER || !RPCPASS) {
	console.error("!! decrypt failed")
	process.exit(1)
}
console.log("  decrypted ok")

section("THE CURRENT STATE")
console.log(`--- ${BITCOINCONF} ---`)
if (exists(BITCOINCONF)) {
	const lines = (await Bun.file(BITCOINCONF).text()).split("\n")
	const relevant = lines
		.map((line, i) => ({ i, line }))
		.filter(({ line }) => /^(rpcuser|rpcpassword|rpcauth|server|zmq|daemon)=/.test(line))
		.map(({ line, i }) => `  ${i + 1}:${line.replace(/^(rpcpassword=).*/, "$1<redacted>")}`)
	if (relevant.length > 0) console.log(relevant.join("\n"))
}

console.log(`\n--- ${LNDCONF} ---`)
if (exists(LNDCONF))
	console.log((await Bun.file(LNDCONF).text()).replaceAll(/^(bitcoind\.rpcpass=).*$/gm, "$1<redacted>"))
else console.log("(absent)")

console.log(`\n--- the unit's ExecStart ---`)
if (exists(UNIT)) {
	const m = /^ExecStart=.*$/m.exec(await Bun.file(UNIT).text())
	console.log(`  ${m?.[0] ?? "(none)"}`)
}

section(`WRITING ${RPCCONF}`)
await $`install -d -m 0755 ${RPCDIR}`.nothrow()

// Carry the zmq settings over; they are part of what the datadir config used to provide.
const zmq = exists(BITCOINCONF)
	? (await Bun.file(BITCOINCONF).text())
			.split("\n")
			.filter(l => /^zmqpub(raw)?(block|tx)=/.test(l))
			.join("\n")
	: ""

const conf = `# Written by bin/14-lnd-creds.ts on ${new Date().toISOString()}
#
# bitcoind reads this file because the unit passes -conf=${RPCCONF}
#
# It lives here rather than in the datadir because /srv/hdd is a fuseblk
# mount where every file is 0777, and the RPC password would be
# world-readable there.

server=1${zmq ? `\n${zmq}` : ""}
rpcuser=${RPCUSER}
rpcpassword=${RPCPASS}
`
await Bun.write(RPCCONF, conf)
await $`chown root:heliodex ${RPCCONF}`.nothrow()
await $`chmod 0640 ${RPCCONF}`.nothrow()

const dirMode = (await $`stat -c %a ${RPCDIR}`.text()).trim()
if (dirMode !== "755") {
	await $`chmod 0755 ${RPCDIR}`.nothrow()
	console.log(`  fixed the mode on ${RPCDIR} (was ${dirMode}, which stopped heliodex from reaching the file)`)
}

console.log(`  wrote ${RPCCONF}`)
console.log(conf.replaceAll(/^(rpcpassword=).*$/gm, "$1<redacted>").replaceAll(/^/gm, "    "))

section("STRIPPING THE CREDENTIALS FROM THE DATADIR CONFIG")
if (exists(BITCOINCONF)) {
	await $`cp -a ${BITCOINCONF} ${BITCOINCONF}.bak.${Math.floor(Date.now() / 1000)}`.nothrow()
	const kept = (await Bun.file(BITCOINCONF).text())
		.split("\n")
		.filter(l => !/^(rpcuser|rpcpassword|rpcauth|daemon)=/.test(l))
		.join("\n")
	await Bun.write(BITCOINCONF, kept)
	console.log("  removed rpcuser, rpcpassword and daemon from it")
	console.log("--- what is left ---")
	console.log(
		kept
			.split("\n")
			.filter(l => /^[a-z]/.test(l))
			.map(l => `    ${l}`)
			.join("\n"),
	)
}

section(`POINTING THE UNIT AT ${RPCCONF}`)
const unitText = exists(UNIT) ? await Bun.file(UNIT).text() : ""
if (unitText.includes("-conf=")) console.log("  the unit already passes -conf")
else {
	const patch = (t: string) => t.replace(/^(ExecStart=.*bitcoind)/m, `$1 -conf=${RPCCONF}`)

	if (unitText) {
		await $`cp -a ${UNIT} ${UNIT}.bak.${Math.floor(Date.now() / 1000)}`.nothrow()
		await Bun.write(UNIT, patch(unitText))
		console.log("  added -conf to the installed unit")
	}
	const repoUnit = `${REPO}/systemd/system/bitcoind.service`
	if (exists(repoUnit) && !(await Bun.file(repoUnit).text()).includes("-conf=")) {
		await Bun.write(repoUnit, patch(await Bun.file(repoUnit).text()))
		console.log("  added -conf to the repo's unit")
	}
	await $`systemctl daemon-reload`.nothrow()
}
const installed = exists(UNIT) ? /^ExecStart=.*$/m.exec(await Bun.file(UNIT).text()) : null
console.log(`  ${installed?.[0] ?? "(no unit installed)"}`)

section("WRITING lnd.conf")
await $`install -d -m 0700 -o heliodex -g heliodex ${LNDDIR}`.nothrow()
if (exists(LNDCONF)) await $`cp -a ${LNDCONF} ${LNDCONF}.bak.${Math.floor(Date.now() / 1000)}`.nothrow()

await Bun.write(LNDCONF, `bitcoind.rpcuser=${RPCUSER}\nbitcoind.rpcpass=${RPCPASS}\n`)
await $`chown heliodex:heliodex ${LNDCONF}`.nothrow()
await $`chmod 0600 ${LNDCONF}`.nothrow()
console.log(`  wrote ${LNDCONF}`)
console.log(`    bitcoind.rpcuser=${RPCUSER}`)
console.log("    bitcoind.rpcpass=<redacted>")

section("VERIFYING")
console.log("--- can the service user reach the config? ---")
const traverse = (await $`su -s /bin/sh heliodex -c ${`test -x '${RPCDIR}'`}`.nothrow().quiet()).exitCode === 0
console.log(`  ${label(`traverse ${RPCDIR}`, 46)} ${traverse ? "ok" : "BLOCKED - bitcoind cannot reach the file"}`)
if (!traverse) {
	await $`chmod 0755 ${RPCDIR}`.nothrow()
	console.log("    fixed")
}

const readable = (await $`su -s /bin/sh heliodex -c ${`test -r '${RPCCONF}'`}`.nothrow().quiet()).exitCode === 0
console.log(`  ${label(`read ${RPCCONF}`, 46)} ${readable ? "ok" : "BLOCKED"}`)
if (!readable) {
	await $`chown root:heliodex ${RPCCONF}`.nothrow()
	await $`chmod 0640 ${RPCCONF}`.nothrow()
	console.log("    fixed")
}

console.log("\n--- can bitcoind authenticate with these credentials? ---")
const CLI = "/home/heliodex/bitcoin/bitcoin-30.0/bin/bitcoin-cli"
if (exists(CLI)) {
	console.log("  (this talks to the running bitcoind, so restart it first if it was started before this script ran)")
	await $`${CLI} -conf=${RPCCONF} -datadir=/srv/hdd/.bitcoin getblockcount`.nothrow()
} else console.log("  (bitcoin-cli not found, skipping)")

console.log("\n--- is the password still anywhere in the clear? ---")
for (const f of [BITCOINCONF, "/usr/sbin/lnd.sh"]) {
	if (!exists(f)) continue
	const has = (await Bun.file(f).text()).includes(RPCPASS)
	console.log(`  ${label(f, 46)} ${has ? "STILL CONTAINS IT" : "clean"}`)
}
for (const [f, note] of [
	[RPCCONF, "contains it, mode 0640 root:heliodex"],
	[LNDCONF, "contains it, mode 0600 heliodex"],
]) {
	const has = (await Bun.file(f).text()).includes(RPCPASS)
	console.log(`  ${label(f, 46)} ${has ? note : "clean"}`)
}

console.log(`
== THEN ==

  systemctl restart bitcoind.service
  systemctl restart lnd.service
  journalctl -u lnd -f

  lnd should now get past "unable to create partial chain control" and
  unlock its wallet.

=== DONE ===
`)
