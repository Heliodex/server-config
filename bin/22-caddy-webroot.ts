#!/usr/bin/env bun
// bin/22-caddy-webroot.ts — move Caddy's web root to /var/www.
//
// Run:  sudo bun bin/22-caddy-webroot.ts
//
// Port of bin/22-caddy-webroot.sh. Caddy runs in the httpd_t domain, which may not read files under a user's home, so the served trees are symlinks from /var/www back to where the data actually lives. The Caddyfile's paths are rewritten to match.

import { $ } from "bun"
import { exists, isDir, label, root } from "./_lib.ts"

root()

const WEBROOT = "/var/www"
const CADDYFILE = `${WEBROOT}/Caddyfile`

await $`mkdir -p ${WEBROOT}`.nothrow()

console.log("== what is there now ==")
const watched = [
	"/home/heliodex/Caddyfile",
	CADDYFILE,
	"/home/heliodex/radicle-explorer/build",
	"/home/mercury/setup",
	"/home/mercury/MercuryCore/Site",
	"/home/heliodex/minecraft",
	"/srv/ssd/_fileserver",
]

for (const p of watched) {
	let line = label(p, 46)
	if (exists(p)) {
		const size = (await $`du -sh ${p}`.nothrow().quiet()).stdout.toString().split("\t")[0]
		line += `exists (${size})`
		const link = await $`readlink ${p}`.nothrow().quiet()
		if (link.exitCode === 0) line += ` -> ${link.stdout.toString().trim()}`
	} else line += "absent"

	console.log(`  ${line}`)
}

console.log("\n== the Caddyfile's paths ==")
for (const f of [CADDYFILE, "/home/heliodex/Caddyfile"]) {
	if (!exists(f)) continue
	console.log(`  ${f}`)
	for (const [i, line] of (await Bun.file(f).text()).split("\n").entries())
		if (/import |root \*/.test(line)) console.log(`    ${i + 1}:${line}`)
}

console.log("\n== moving ==")
if (exists("/home/heliodex/Caddyfile") && !exists(CADDYFILE)) {
	await $`cp -a /home/heliodex/Caddyfile ${CADDYFILE}`.nothrow()
	await $`chmod 0644 ${CADDYFILE}`.nothrow()
	console.log(`  /home/heliodex/Caddyfile -> ${CADDYFILE}`)
} else if (exists(CADDYFILE)) console.log(`  ${CADDYFILE} already exists, leaving it`)
else {
	console.error("  !! no Caddyfile found in either place")
	process.exit(1)
}

async function linkTree(src: string, dst: string): Promise<void> {
	if (!exists(src)) {
		console.log(`  ${src} absent, skipping`)
		return
	}
	if (exists(dst)) await $`rm -rf ${dst}`.nothrow()
	await $`ln -s ${src} ${dst}`.nothrow()
	console.log(`  ${dst} -> ${src}`)
}

await linkTree("/home/heliodex/radicle-explorer/build", `${WEBROOT}/radicle-explorer`)
await linkTree("/home/mercury/setup", `${WEBROOT}/mercury-setup`)
await linkTree("/home/mercury/MercuryCore/Site", `${WEBROOT}/mercury-site`)
await linkTree("/home/heliodex/minecraft", `${WEBROOT}/minecraft`)
await linkTree("/srv/ssd/_fileserver", `${WEBROOT}/fileserver`)

console.log("\n== rewriting the Caddyfile's paths ==")
if (exists(CADDYFILE)) {
	const before = await Bun.file(CADDYFILE).text()
	const after = before
		.replaceAll("/home/mercury/MercuryCore/Site/Caddyfile", `${WEBROOT}/mercury-site/Caddyfile`)
		.replaceAll("/home/heliodex/minecraft/Caddyfile", `${WEBROOT}/minecraft/Caddyfile`)
		.replaceAll("/srv/ssd/_fileserver/Caddyfile", `${WEBROOT}/fileserver/Caddyfile`)
		.replaceAll("root * /home/mercury/setup", `root * ${WEBROOT}/mercury-setup`)
		.replaceAll("root * /home/heliodex/radicle-explorer/build", `root * ${WEBROOT}/radicle-explorer`)

	if (after !== before) await Bun.write(CADDYFILE, after)
	console.log("  rewrote the imports and roots")
	console.log("\n--- the paths it now refers to ---")
	for (const [i, line] of after.split("\n").entries())
		if (/import |root \*/.test(line)) console.log(`    ${i + 1}:${line}`)
}

console.log("\n== the token ==")
const conf = await Bun.file(CADDYFILE).text()
if (conf.includes("nfp_")) {
	console.log("  !! the Caddyfile still has a literal Netlify token.")
	console.log("     replace it with a variable and put the value in the env file:")
	console.log(`       sed -i 's/dns netlify nfp_[A-Za-z0-9]*/dns netlify {\\$NETLIFY_API_TOKEN}/' ${CADDYFILE}`)
	console.log(String.raw`       printf 'NETLIFY_API_TOKEN=%s\n' TOKEN > /etc/caddy/netlify.env`)
	console.log("       chown root:caddy /etc/caddy/netlify.env && chmod 0640 /etc/caddy/netlify.env")
} else {
	console.log("  the Caddyfile uses {$NETLIFY_API_TOKEN}, good")
	if (exists("/etc/caddy/netlify.env")) {
		const mode = (await $`stat -c %a /etc/caddy/netlify.env`.text()).trim()
		console.log(`  /etc/caddy/netlify.env exists (root:caddy ${mode})`)
	} else {
		console.log("  !! /etc/caddy/netlify.env is missing")
		console.log("     run bin/20-caddy.ts to create it")
	}
}

console.log("\n== labels ==")
await $`ls -Zd ${WEBROOT}`.nothrow()
await $`ls -Zd ${CADDYFILE}`.nothrow()
console.log("\n  the symlinked trees keep their original labels, since SELinux")
console.log("  resolves the link. Run bin/40-selinux.ts to label them.")

// Report the symlink targets so it is obvious what 40-selinux.ts will have to touch.
for await (const name of new Bun.Glob("*").scan({ cwd: WEBROOT, onlyFiles: false })) {
	const p = `${WEBROOT}/${name}`
	const r = await $`readlink -f ${p}`.nothrow().quiet()
	if (r.exitCode === 0 && isDir(p)) console.log(`  ${p} -> ${r.stdout.toString().trim()}`)
}

console.log(`
== THEN ==

  sudo bun bin/40-selinux.ts
  sudo bun bin/30-install.ts --apply
  systemctl start caddy.service && journalctl -u caddy -f

=== DONE ===
`)
