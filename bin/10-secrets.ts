#!/usr/bin/env bun
// bin/10-secrets.ts — create the systemd credentials the services need.
//
// Run:  sudo bun bin/10-secrets.ts
//
// The credential's embedded name, its filename and the ID the unit asks for are all the same string with no extension: `systemd-creds decrypt` validates the embedded name against the basename, while the service manager validates it against the ID, and a mismatch is refused.

import { $ } from "bun"
import { exists, label, root } from "./_lib.ts"

root()

const CREDSTORE = "/etc/credstore.encrypted"

await $`install -d -m 0700 ${CREDSTORE}`.nothrow()

console.log("== TPM2 present?")
const tpm = (await $`systemd-creds --tpm2-device=list`.nothrow().quiet()).stdout.toString()
const KEY = tpm.includes("/dev/tpm") ? "tpm2" : "host"

if (KEY === "tpm2") console.log("  -> credentials will be TPM2-bound (decryptable only on this machine)")
else {
	console.log("  -> no TPM2; credentials bound to /var/lib/systemd/credential.secret")
	console.log("     BACK THAT FILE UP or the credentials become unreadable:")
	console.log("     sudo cp -a /var/lib/systemd/credential.secret ~/credential.secret.bak")
}

/** Re-encrypt a credential left in the old location by an earlier script. */
async function migrate(name: string): Promise<boolean> {
	const candidates = [`/etc/credstore/${name}.cred`, `/etc/credstore/${name}`]
	const old = candidates.find(p => exists(p))
	if (!old) return false

	console.log(`  ${name}: migrating ${old}`)
	const tmp = `${CREDSTORE}/.migrating-${name}`

	const dec = await $`systemd-creds decrypt --name=${name} ${old}`.nothrow().quiet()
	if (dec.exitCode !== 0) {
		console.log(`  ${name}: could not migrate ${old}, re-asking`)
		return false
	}

	await Bun.write(tmp, dec.stdout)
	const enc = await $`systemd-creds encrypt --name=${name} --with-key=${KEY} ${tmp} ${CREDSTORE}/${name}`
		.nothrow()
		.quiet()
	await $`rm -f ${tmp}`.nothrow()

	if (enc.exitCode !== 0) {
		console.log(`  ${name}: could not migrate ${old}, re-asking`)
		return false
	}

	await $`chmod 0600 ${CREDSTORE}/${name}`.nothrow()
	await $`rm -f ${old}`.nothrow()
	console.log(`  ${name}: migrated to ${CREDSTORE}/${name}`)
	return true
}

/** Create one credential, or leave alone the one that is already there. */
async function create(name: string, prompt: string): Promise<boolean> {
	const file = `${CREDSTORE}/${name}`
	if (exists(file)) {
		console.log(`  ${name}: already exists, leaving alone`)
		return true
	}
	if (await migrate(name)) return true

	console.log(`  ${name}: ${prompt}`)

	// systemd-ask-password reads the terminal itself, so it needs the real stdin; systemd-creds takes the value on stdin.
	const ask = Bun.spawnSync(["systemd-ask-password", prompt], { stderr: "inherit", stdin: "inherit", stdout: "pipe" })
	if (ask.exitCode !== 0) {
		console.log(`  ${name}: FAILED`)
		return false
	}

	const tmp = `${CREDSTORE}/.new-${name}`
	await Bun.write(tmp, ask.stdout)
	const enc = await $`systemd-creds encrypt --name=${name} --with-key=${KEY} ${tmp} ${file}`.nothrow().quiet()
	await $`rm -f ${tmp}`.nothrow()

	if (enc.exitCode !== 0) {
		console.log(`  ${name}: FAILED`)
		return false
	}

	await $`chmod 0600 ${file}`.nothrow()
	console.log(`  ${name}: written to ${file}`)
	return true
}

console.log("\n== creating credentials")
await create("lnd-wallet-pass", "LND wallet unlock password: ")
await create("bitcoin-rpcuser", "bitcoind RPC username [Heliodex]: ")
await create("bitcoin-rpcpass", "bitcoind RPC password: ")
await create("rcon-password", "PaperMC RCON password (set enable-rcon=true in server.properties): ")

console.log("\n== verifying each credential round-trips")
for await (const name of new Bun.Glob("*").scan({ cwd: CREDSTORE })) {
	const file = `${CREDSTORE}/${name}`
	const ok = (await $`systemd-creds decrypt ${file}`.nothrow().quiet()).exitCode === 0
	console.log(`  ${label(name, 28)} ${ok ? "ok" : "FAILED (name mismatch or bad key)"}`)
}

console.log("\n== writing the plain-text fallback for the RCON password")
const rcon = `${CREDSTORE}/rcon-password`
if (exists(rcon)) {
	const dec = await $`systemd-creds decrypt ${rcon}`.nothrow().quiet()
	if (dec.exitCode === 0) {
		const tmp = await $`mktemp`.text()
		await Bun.write(tmp.trim(), dec.stdout)
		await $`install -o heliodex -g heliodex -m 0400 ${tmp.trim()} /etc/credstore/rcon-password`.nothrow()
		await $`rm -f ${tmp.trim()}`.nothrow()
		console.log("  wrote /etc/credstore/rcon-password (heliodex:heliodex 0400)")
	} else console.log("  could not decrypt rcon-password, skipping")
} else console.log("  no rcon-password credential, skipping")

console.log(`
== the bitcoind RPC password is moved out of the plaintext places by bin/14-lnd-creds.ts
== the Netlify token is handled by bin/20-caddy.ts, not here.

== then place the LND wallet password where lnd expects it:
     sudo bun bin/12-lnd-wallet.ts

== done
`)
