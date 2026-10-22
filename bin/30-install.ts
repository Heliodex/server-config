#!/usr/bin/env bun
// bin/30-install.ts — install the tracked systemd units onto this server.
//
// Run:  bun bin/30-install.ts           (dry run, prints what it would do)
// sudo bun bin/30-install.ts --apply
//
// Port of bin/30-install.sh. Installs units, helpers and the extracted lnbits tree. Does not start or enable anything: that is a separate, deliberate step.

import { $ } from "bun"
import { exists, label, REPO, root } from "./_lib.ts"

const APPLY = process.argv.includes("--apply")
root()

const SRC = `${REPO}/systemd/system`
const REPO_UNITS = "/etc/systemd/system"
let fail = false

/** Echo the command, then run it — unless this is a dry run. */
async function run(argv: string[], description?: string): Promise<void> {
	console.log(`  ${description ?? argv.join(" ")}`)
	if (!APPLY) return
	const r = await $`${argv}`.nothrow()
	if (r.exitCode !== 0) {
		console.error(`  !! FAILED: ${argv.join(" ")}`)
		fail = true
	}
}

const stamp = () => Math.floor(Date.now() / 1000)

console.log(`== source: ${SRC}`)

console.log("\n== installing unit files")
await $`install -d -m 0755 ${REPO_UNITS}`.nothrow()

const units: string[] = []
for (const pattern of ["*.service", "*.slice", "*.timer"])
	for await (const name of new Bun.Glob(pattern).scan({ cwd: SRC })) units.push(name)

for (const name of units.toSorted()) {
	const src = `${SRC}/${name}`
	const dst = `${REPO_UNITS}/${name}`

	const differs = exists(dst) && (await Bun.file(dst).text()) !== (await Bun.file(src).text())
	if (differs && APPLY) {
		await $`cp -a ${dst} ${dst}.bak.${stamp()}`.nothrow()
		console.log(`  backed up existing ${name}`)
	} else if (differs) console.log(`  would back up existing ${name}`)

	await run(["install", "-Dm644", src, dst])
}

// Drop-in directories, e.g. btrfs-scrub.timer.d/
for await (const dir of new Bun.Glob("*.d").scan({ cwd: SRC, onlyFiles: false })) {
	await run(["install", "-d", "-m", "0755", `${REPO_UNITS}/${dir}`])
	for await (const conf of new Bun.Glob("*.conf").scan({ cwd: `${SRC}/${dir}` }))
		await run(["install", "-Dm644", `${SRC}/${dir}/${conf}`, `${REPO_UNITS}/${dir}/${conf}`])
}

console.log("\n== installing helper scripts")
await run(["install", "-d", "-m", "0755", "/usr/local/libexec"])
const helpers: string[] = []
for (const pattern of ["*.sh", "*.js"])
	for await (const name of new Bun.Glob(pattern).scan({ cwd: `${REPO}/libexec` })) helpers.push(name)

for (const name of helpers.toSorted())
	await run(["install", "-Dm755", `${REPO}/libexec/${name}`, `/usr/local/libexec/${name}`])

// A missing helper makes every unit that references it fail with a confusing "not executable", and it is easy to miss if the install failed silently.
console.log("\n== checking helper scripts")
for (const name of helpers.toSorted()) {
	const ok =
		exists(`/usr/local/libexec/${name}`)
		&& (await $`test -x ${`/usr/local/libexec/${name}`}`.nothrow().quiet()).exitCode === 0
	console.log(`  ${label(name, 20)} ${ok ? "installed and executable" : "MISSING or not executable"}`)
	if (!ok) fail = true
}

// "systemctl set-property" writes a drop-in under system.control that overrides the unit file across reboots, so a stale one means the slice files here are not actually in charge.
console.log("\n== clearing stale set-property drop-ins")
for await (const dir of new Bun.Glob("*.slice.d").scan({ cwd: "/etc/systemd/system.control", onlyFiles: false })) {
	const path = `/etc/systemd/system.control/${dir}`
	const confs: string[] = []
	for await (const c of new Bun.Glob("*.conf").scan({ cwd: path })) confs.push(c)
	if (confs.length === 0) continue
	console.log(`  ${dir}:`)
	for (const c of confs) console.log(`    ${c}`)
	await run(["rm", "-f", ...confs.map(c => `${path}/${c}`)])
}
console.log("  (the unit files are the source of truth)")

// lnbits ships as an AppImage. FUSE is unavailable to a service, and its extraction fallback does not survive the sandbox, so it is extracted once here and the unit runs the extracted binary.
console.log("\n== extracting AppImages")
const APPIMAGE = "/home/heliodex/lightning/lnbits-1.1.0"
const EXTRACT = "/opt/lnbits"
const APPRUN = `${EXTRACT}/squashfs-root/AppRun`

if (!exists(APPIMAGE)) console.log(`  lnbits: ${APPIMAGE} not present, skipping`)
else if (exists(APPRUN)) console.log("  lnbits: already extracted")
else {
	console.log("  lnbits: extracting (this takes a moment)")
	if (APPLY) {
		await $`rm -rf ${EXTRACT}`.nothrow()
		await $`install -d -m 0755 ${EXTRACT}`.nothrow()
		// --appimage-extract writes squashfs-root into the working directory.
		await $`${APPIMAGE} --appimage-extract`.cwd(EXTRACT).nothrow().quiet()

		if (exists(APPRUN)) {
			await $`chown -R heliodex:heliodex ${EXTRACT}`.nothrow()
			// Do not chmod the whole tree: the extraction already records the right modes, and a blanket 0644 strips the execute bit off the binaries inside.
			await $`chmod 0755 ${APPRUN}`.nothrow()
			await $`chmod 0755 ${EXTRACT}/squashfs-root/usr/lnbits/dist/lnbits`.nothrow()
			console.log(`  lnbits: extracted to ${EXTRACT}/squashfs-root`)
		} else {
			console.error("  !! lnbits: extraction failed")
			fail = true
		}
	}
}

console.log("\n== validating")
for (const name of units.filter(n => /\.(service|slice)$/.test(n)).toSorted()) {
	const unitPath = `${SRC}/${name}`
	const r = await $`systemd-analyze verify ${unitPath}`.nothrow().quiet()
	const ours = (r.stdout.toString() + r.stderr.toString())
		.split("\n")
		.filter(l => l.includes(`${SRC}/`))
		.join("\n")
		.trim()

	if (!ours) console.log(`  ${label(name, 30)} ok`)
	else {
		console.log(`  ${label(name, 30)} PROBLEMS`)
		console.log(
			ours
				.split("\n")
				.slice(0, 10)
				.map(l => `      ${l}`)
				.join("\n"),
		)
		fail = true
	}
}

if (!APPLY) {
	console.log("\nDRY RUN. Nothing was changed. Re-run with --apply to install.")
	process.exit(0)
}

if (fail) {
	console.log("\nSOMETHING FAILED. See the messages marked with !! above.")
	console.log("Nothing was started. Fix the problem and run this again.")
	process.exit(1)
}

console.log("\n== reloading systemd")
await $`systemctl daemon-reload`.nothrow()

console.log(`
== done. Not starting anything yet.

Next:
  bun bin/status.ts                     # what is running, what is enabled
  sudo bun bin/60-enable-all.ts         # enable and start them all

The units are installed but not enabled, so nothing starts at boot until
you enable it. That is deliberate: enable them one at a time at first, so
you can watch each one fail.

Retire the old supervisor:
  sudo bun bin/50-retire.ts
`)
