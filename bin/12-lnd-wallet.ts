#!/usr/bin/env bun
// bin/12-lnd-wallet.ts — place the LND wallet password where lnd expects it.
//
// Run:  sudo bun bin/12-lnd-wallet.ts
//
// Port of bin/12-lnd-wallet.sh. lnd's --wallet-unlock-password-file wants a plain file owned by the lnd user, mode 0400. This decrypts the systemd credential and writes that file. Re-run it if the credential is ever rotated.

import { $ } from "bun"
import { exists, root } from "./_lib.ts"

root()

const CRED = "/etc/credstore.encrypted/lnd-wallet-pass"
const TARGET = "/home/heliodex/.lnd/wallet-password"

if (!exists(CRED)) {
	console.log(`no credential at ${CRED} - run bin/10-secrets.ts first`)
	process.exit(1)
}

// Leave a file that is newer than the credential alone, so this is safe to re-run without clobbering a password the operator set by hand.
if (exists(TARGET)) {
	const target = Bun.file(TARGET)
	const cred = Bun.file(CRED)
	if (target.lastModified > cred.lastModified) {
		console.log(`${TARGET} is already newer than the credential; leaving it alone`)
		process.exit(0)
	}
}

const dec = await $`systemd-creds decrypt ${CRED}`.nothrow().quiet()
if (dec.exitCode !== 0) {
	console.error("decrypt failed")
	process.exit(1)
}
if (dec.stdout.length === 0) {
	console.error("decrypted credential is empty")
	process.exit(1)
}

const tmp = (await $`mktemp`.text()).trim()
try {
	await Bun.write(tmp, dec.stdout)
	await $`install -o heliodex -g heliodex -m 0400 ${tmp} ${TARGET}`.nothrow()
} finally {
	await $`rm -f ${tmp}`.nothrow()
}

console.log(`wrote ${TARGET} (heliodex:heliodex 0400)`)
console.log("\nlnd.service points at it with:")
console.log(`  --wallet-unlock-password-file=${TARGET}`)
