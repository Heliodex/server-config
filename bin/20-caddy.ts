#!/usr/bin/env bun
// bin/20-caddy.ts — install the Caddyfile, the caddy build and the token.
//
// Run:  sudo bun bin/20-caddy.ts
//
// Port of bin/20-caddy.sh. The custom build lives in /usr/local/bin so a package update cannot overwrite it, and needs the httpd_exec_t label because that is what puts the process in the httpd_t domain.

import { $ } from "bun"
import { exists, have, REPO, root } from "./_lib.ts"

root()

const WEBROOT = "/var/www"
const DEST = "/usr/local/bin/caddy"
const TOKEN_FILE = "/etc/caddy/netlify.token"
const ENV_FILE = "/etc/caddy/netlify.env"

await $`install -d -m 0755 ${WEBROOT}`.nothrow()
await $`install -m 0644 ${REPO}/etc/caddy/Caddyfile ${WEBROOT}/Caddyfile`.nothrow()
console.log(`== installed ${WEBROOT}/Caddyfile`)

// Find the build that has the netlify DNS module. The destination is skipped as a source, because copying a file onto itself fails.
const candidates = ["/home/heliodex/caddy/xcb/caddy", "/home/heliodex/caddy/caddy", "/bin/caddy", "/usr/bin/caddy"]

let src = ""
for (const cand of candidates) {
	if (cand === DEST) continue
	if (!exists(cand)) continue
	if ((await $`test -L ${cand}`.nothrow().quiet()).exitCode === 0) continue
	if ((await $`test -x ${cand}`.nothrow().quiet()).exitCode !== 0) continue
	if ((await $`${cand} version`.nothrow().quiet()).exitCode === 0) {
		src = cand
		break
	}
}

if (!src)
	if (exists(DEST) && (await $`${DEST} version`.nothrow().quiet()).exitCode === 0)
		console.log(`== ${DEST} is already a caddy binary, using it in place`)
	else {
		console.error("!! no caddy binary found to install")
		console.error("   looked in ~/caddy/xcb/caddy, ~/caddy/caddy, /bin/caddy, /usr/bin/caddy")
		process.exit(1)
	}
else {
	console.log(`== installing ${src} to ${DEST}`)
	await $`install -m 0755 ${src} ${DEST}`.nothrow()
}

await $`${DEST} version`.nothrow()

// Caddy must be httpd_exec_t. stat -c %C prints the context directly; the shell version parsed `ls -Z`, whose second field is the path, so its comparison never matched and it relabelled every run.
const type = (await $`stat -c %C ${DEST}`.nothrow().text()).trim().split(":")[2]
console.log("\n== label check")
console.log(`  ${DEST} is ${type}`)
if (type !== "httpd_exec_t") {
	console.log("  labelling it httpd_exec_t, which gives the init_t -> httpd_t transition")
	if (have("semanage")) {
		await $`semanage fcontext -a -t httpd_exec_t ${DEST}`.nothrow()
		await $`restorecon -v ${DEST}`.nothrow()
	} else {
		console.log("    (semanage not installed; falling back to chcon)")
		await $`chcon -t httpd_exec_t ${DEST}`.nothrow()
	}
	const now = (await $`stat -c %C ${DEST}`.nothrow().text()).trim().split(":")[2]
	console.log(`  now: ${now}`)
}

await $`install -d -m 0755 /etc/caddy`.nothrow()

if (!exists(TOKEN_FILE)) {
	// Lift an existing plaintext token out of either Caddyfile.
	let old = ""
	for (const f of [`${WEBROOT}/Caddyfile`, "/home/heliodex/Caddyfile"]) {
		if (!exists(f)) continue
		const m = /nfp_[A-Za-z0-9]+/.exec(await Bun.file(f).text())
		if (m) {
			old = m[0]
			break
		}
	}
	if (old) {
		console.log("== lifting the token out of the Caddyfile")
		await Bun.write(TOKEN_FILE, old)
	} else {
		console.log(`== no token found; create ${TOKEN_FILE} manually`)
		await Bun.write(TOKEN_FILE, "")
	}
}

const token = (await Bun.file(TOKEN_FILE).text()).trim()
await $`chown root:caddy ${TOKEN_FILE}`.nothrow()
await $`chmod 0640 ${TOKEN_FILE}`.nothrow()
await Bun.write(ENV_FILE, `NETLIFY_API_TOKEN=${token}\n`)
await $`chown root:caddy ${ENV_FILE}`.nothrow()
await $`chmod 0640 ${ENV_FILE}`.nothrow()
console.log(`== wrote ${TOKEN_FILE} and ${ENV_FILE} (root:caddy 0640)`)

if (exists("/home/heliodex/Caddyfile")) {
	const text = await Bun.file("/home/heliodex/Caddyfile").text()
	if (text.includes("nfp_")) {
		console.log("\n!! /home/heliodex/Caddyfile still contains a plaintext token.")
		console.log("   Redact it once the new config is verified:")
		console.log("     sed -i 's/nfp_[A-Za-z0-9]*/REDACTED/' /home/heliodex/Caddyfile")
	}
}

console.log(`
== the unit needs these paths =

  [Service]
  ExecStart=${DEST} run --config ${WEBROOT}/Caddyfile
  ExecReload=${DEST} reload --config ${WEBROOT}/Caddyfile --force
  EnvironmentFile=${ENV_FILE}
  ReadOnlyPaths=${WEBROOT}

== then:

  sudo bun bin/30-install.ts --apply
  systemctl start caddy.service && journalctl -u caddy -f
`)
