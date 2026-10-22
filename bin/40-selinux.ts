#!/usr/bin/env bun
// bin/40-selinux.ts — all of the SELinux configuration this box needs.
//
// Run:  sudo bun bin/40-selinux.ts
//
// Port of bin/40-selinux.sh, and the only thing that changes SELinux policy. Everything here is persistent: fcontext rules, port labels and one boolean.
//
// * a binary systemd executes directly must be bin_t, or init_t is denied; a symlink does not help, because SELinux applies the target's label
// * caddy must be httpd_exec_t rather than bin_t, since that is what puts it in the httpd_t domain
// * httpd_t may only bind http_port_t ports, and may not reach the network unless httpd_can_network_connect is on
// * files PID 1 reads as EnvironmentFile must be readable by init_t, and a file under /etc is not automatically

import { $ } from "bun"
import { exists, have, isDir, label, root } from "./_lib.ts"

root()

if (!have("semanage")) {
	console.error("!! semanage is not installed")
	console.error("   sudo zypper install policycoreutils-python-utils")
	process.exit(1)
}

console.log("== SELinux ==")
console.log(`  ${(await $`getenforce`.nothrow().text()).trim()}`)

/** The SELinux type of a path. stat -c %C prints the context directly. */
async function typeOf(path: string): Promise<string> {
	const ctx = (await $`stat -c %C ${path}`.nothrow().quiet()).stdout.toString().trim()
	return ctx.split(":")[2] ?? ""
}

async function labelFile(path: string, want: string, pattern = path): Promise<void> {
	if (!exists(path)) {
		console.log(`  ${label(path, 52)} absent`)
		return
	}

	const now = await typeOf(path)
	if (now === want) {
		console.log(`  ${label(path, 52)} already ${want}`)
		return
	}

	// -a adds; when a rule for that pattern already exists, -m modifies it.
	const add = await $`semanage fcontext -a -t ${want} ${pattern}`.nothrow().quiet()
	if (add.exitCode !== 0) await $`semanage fcontext -m -t ${want} ${pattern}`.nothrow().quiet()
	await $`restorecon ${path}`.nothrow().quiet()

	console.log(`  ${label(path, 52)} ${now || "?"} -> ${await typeOf(path)}`)
}

console.log("\n== 1. binaries that systemd executes directly: bin_t ==")

// bitcoind lives in a versioned directory, so label the pattern and apply it to whichever version is installed.
const bitcoinds: string[] = []
for await (const p of new Bun.Glob("*/*/bin/bitcoind").scan({ cwd: "/home/heliodex/bitcoin", onlyFiles: true }))
	bitcoinds.push(`/home/heliodex/bitcoin/${p}`)

const BITCOIND = bitcoinds.toSorted().at(-1) ?? ""
if (BITCOIND) await labelFile(BITCOIND, "bin_t", "/home/heliodex/bitcoin/[^/]*/bin/bitcoind")

await labelFile("/home/heliodex/.bun/bin/bun", "bin_t")
await labelFile("/home/heliodex/urbit/urbit", "bin_t")
await labelFile("/home/heliodex/lightning/lnd", "bin_t")
await labelFile("/home/heliodex/albyhub/bin/albyhub", "bin_t")
await labelFile("/opt/lnbits/squashfs-root/usr/lnbits/dist/lnbits", "bin_t")

for (const f of [
	"/home/heliodex/.radicle/bin/radicle-node",
	"/home/heliodex/.radicle/bin/rad",
	"/home/heliodex/.radicle/bin/git-remote-rad",
])
	await labelFile(f, "bin_t")

for (const b of ["gateway", "litecode", "wallflower"]) {
	const real = (await $`readlink -f ${`/usr/bin/${b}`}`.nothrow().quiet()).stdout.toString().trim()
	if (real) await labelFile(real, "bin_t")
}

// Mercury Core spawns Economy as a subprocess, the same way it spawns SurrealDB, so those executables need to be executable by init_t too.
for await (const f of new Bun.Glob("**/*").scan({ cwd: "/home/mercury/MercuryCore/Economy", onlyFiles: true })) {
	const path = `/home/mercury/MercuryCore/Economy/${f}`
	const exec = (await $`test -x ${path}`.nothrow().quiet()).exitCode === 0
	if (exec) await labelFile(path, "bin_t")
}

console.log("\n== 2. caddy: httpd_exec_t, not bin_t ==")
await labelFile("/usr/local/bin/caddy", "httpd_exec_t")

console.log("\n== 3. what httpd_t may do ==")
const bool = (await $`getsebool httpd_can_network_connect`.nothrow().quiet()).stdout
	.toString()
	.trim()
	.split("-->")[1]
	?.trim()
if (bool === "on") console.log(`  ${label("httpd_can_network_connect", 52)} already on`)
else {
	await $`setsebool -P httpd_can_network_connect 1`.nothrow()
	console.log(`  ${label("httpd_can_network_connect", 52)} turned on (persistent)`)
}
console.log("  (without it caddy cannot reach Let's Encrypt, so no certificates)")

// Only the ports caddy BINDS: those in a site address, not the reverse_proxy targets and not the numbers inside IP addresses.
const CADDYFILE = "/var/www/Caddyfile"
if (exists(CADDYFILE)) {
	const ports = new Set<number>([80, 443])
	for (const line of (await Bun.file(CADDYFILE).text()).split("\n")) {
		if (!/^\s*(https?:\/\/)?[^\s]*:\d{2,5}\s*\{/.test(line)) continue
		for (const m of line.matchAll(/:(\d{2,5})/g)) ports.add(Number(m[1]))
	}

	const labelled = (await $`semanage port -l`.nothrow().quiet()).stdout.toString()
	for (const p of [...ports].toSorted((a, b) => a - b)) {
		const already = labelled
			.split("\n")
			.filter(l => l.startsWith("http_port_t"))
			.some(l => l.split(/\s+/).includes(String(p)))

		if (already) {
			console.log(`  ${label(`tcp/${p}`, 12)} already http_port_t`)
			continue
		}
		const add = await $`semanage port -a -t http_port_t -p tcp ${String(p)}`.nothrow().quiet()
		if (add.exitCode !== 0) await $`semanage port -m -t http_port_t -p tcp ${String(p)}`.nothrow().quiet()
		console.log(`  ${label(`tcp/${p}`, 12)} labelled http_port_t`)
	}
} else console.log(`\n  ${CADDYFILE} not found, skipping port labels (bin/20-caddy.ts)`)

console.log("\n== 4. the files systemd reads itself: etc_t ==")
// Every EnvironmentFile the installed units name, including the ones under /etc: /etc/caddy/netlify.env picks up httpd_sys_content_t from the policy for that directory, and that is the label that silently stopped the Netlify token reaching caddy.
const envFiles = new Set<string>()
for await (const unit of new Bun.Glob("*.service").scan({ cwd: "/etc/systemd/system" })) {
	const text = await Bun.file(`/etc/systemd/system/${unit}`).text()
	for (const m of text.matchAll(/^EnvironmentFile=-?(.*)$/gm)) {
		const value = m[1]
		if (!value) continue
		for (const p of value.trim().split(/\s+/)) if (p.startsWith("/")) envFiles.add(p)
	}
}
for (const p of [...envFiles].toSorted()) await labelFile(p, "etc_t")

console.log("\n== 5. what caddy serves: httpd_sys_content_t ==")
await labelFile(CADDYFILE, "httpd_sys_content_t")

// SELinux resolves a symlink and applies the target's label, so the target is what has to be labelled.
for await (const name of new Bun.Glob("*").scan({ cwd: "/var/www", onlyFiles: false })) {
	const p = `/var/www/${name}`
	const target = (await $`readlink -f ${p}`.nothrow().quiet()).stdout.toString().trim()
	if (!target || !isDir(target)) continue
	await labelFile(target, "httpd_sys_content_t", `${target}(/.*)?`)
}

console.log("\n== result ==")
for (const f of [BITCOIND, "/usr/local/bin/caddy", "/home/heliodex/.bun/bin/bun", "/home/heliodex/urbit/urbit"]) {
	if (!f) continue
	console.log(`  ${label(f, 52)} ${await typeOf(f)}`)
}
const finalBool = (await $`getsebool httpd_can_network_connect`.nothrow().quiet()).stdout
	.toString()
	.trim()
	.split("-->")[1]
	?.trim()
console.log(`  ${label("httpd_can_network_connect", 52)} ${finalBool}`)

console.log(`
Now restart anything whose label changed:
  sudo bun bin/30-install.ts --apply && sudo bun bin/60-enable-all.ts

=== DONE ===
`)
