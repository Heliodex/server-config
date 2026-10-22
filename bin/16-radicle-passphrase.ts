#!/usr/bin/env bun
// bin/16-radicle-passphrase.ts — give radicle-node its keystore passphrase.
//
// Run:  sudo bun bin/16-radicle-passphrase.ts
//
// Port of bin/16-radicle-passphrase.sh. The keystore at ~/.radicle/keys/radicle is an OpenSSH key encrypted with bcrypt, so radicle-node needs the passphrase to unlock it at startup. The passphrase goes in a root-owned 0400 file that only the unit reads, rather than in the unit file where `systemctl cat` would show it.
//
// The file is always written, then the node is started once to confirm the passphrase actually works. An earlier version tried to detect whether the keystore was encrypted, guessed wrong, and exited without writing anything, so the unit looped on "keystore is encrypted".

import { $ } from "bun"
import { exists, readLine, readSecret, root, show } from "./_lib.ts"

root()

const ENVFILE = "/etc/radicle/radicle.env"
const KEYDIR = "/home/heliodex/.radicle/keys"
const KEYFILE = `${KEYDIR}/radicle`

await $`install -d -m 0755 /etc/radicle`.nothrow()

console.log("== radicle keystore ==")
await $`ls -la ${KEYDIR}`.nothrow()

if (!exists(KEYFILE)) {
	console.error(`!! no keystore at ${KEYFILE}`)
	process.exit(1)
}

const key = await Bun.file(KEYFILE).text()
if (key.includes("ENCRYPTED") || key.includes("bcrypt"))
	console.log("  keystore is encrypted, a passphrase is required")
else {
	console.log("  keystore does not look encrypted, but RAD_PASSPHRASE is harmless")
	console.log("  (it will simply be ignored)")
}

console.log("\n== enter the passphrase you chose during 'rad auth' ==")
const pass = process.stdin.isTTY ? readSecret("passphrase: ") : readLine("passphrase: ")

if (!pass.trim()) {
	console.error("!! no passphrase given")
	process.exit(1)
}

await Bun.write(ENVFILE, `RAD_PASSPHRASE=${pass.trimEnd()}\n`)
await $`chown root:root ${ENVFILE}`.nothrow()
await $`chmod 0400 ${ENVFILE}`.nothrow()
console.log(`\n  wrote ${ENVFILE} (root:root 0400)`)

console.log("\n== verifying that the passphrase actually works ==")
// A different port from the unit's 8776, so a running node does not clash with the test.
await show(
	$`RAD_HOME=/home/heliodex/.radicle RAD_PASSPHRASE=${pass} timeout 12 /usr/bin/radicle-node --listen [::]:18776 --force`,
	"  ",
)

console.log("\n  if the output above shows the node past 'Unlocking node keystore',")
console.log("  the passphrase is correct. Otherwise it is wrong.")
console.log("\nStart the unit with:")
console.log("  systemctl start radicle-node.service")
console.log("  journalctl -u radicle-node -f")
