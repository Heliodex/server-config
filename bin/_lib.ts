// Shared helpers for the TypeScript versions of the scripts in this directory. Every one of them is an equivalent of the .sh beside it, run with `bun bin/<name>.ts` instead of `bash bin/<name>.sh`.
//
// Bun shell escapes interpolated values by default, which is the main reason these are shorter: no quoting, no `"$var"` discipline, and a non-zero exit is an exception unless you ask for one.

import { existsSync, statSync } from "node:fs"
import type { $ } from "bun"

/** What a tagged `$` template returns, so the helpers below stay typed. */
type Cmd = ReturnType<typeof $>

export const REPO = `${import.meta.dir}/..`

/** The same root check every shell script starts with. */
export function root(): void {
	if (process.getuid?.() !== 0) {
		console.error("must run as root")
		process.exit(1)
	}
}

/** "==================== TITLE ====================" */
export function section(title: string): void {
	console.log(`\n==================== ${title} ====================`)
}

/** A left-aligned label with no trailing newline, for aligned output. */
export function label(value: string, width = 52): string {
	return value.padEnd(width)
}

export function exists(path: string): boolean {
	return existsSync(path)
}

export function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

/** Is this an executable on PATH? The equivalent of `command -v`. */
export function have(cmd: string): boolean {
	return Bun.which(cmd) !== null
}

/** Run a command and print its output indented, the way the shell scripts do with `| sed 's/^/    /'`. Never throws: the shell scripts print and carry on, and so does this. */

export async function show(cmd: Cmd, indent = "    "): Promise<number> {
	const r = await cmd.nothrow().quiet()
	const out = (r.stdout.toString() + r.stderr.toString()).trimEnd()
	if (out) console.log(out.replaceAll(/^/gm, indent))
	return r.exitCode
}

/** Run a command and return its trimmed stdout, or "" on failure. */
export async function text(cmd: Cmd): Promise<string> {
	const r = await cmd.nothrow().quiet()
	return r.stdout.toString().trim()
}

/** Read a line from the terminal without echoing it. Bun has no hidden prompt of its own, so this borrows the shell's `read -s`, which needs a terminal. Falls back to reading a plain line when there is none. */

export function readSecret(prompt: string): string {
	const r = Bun.spawnSync(
		[
			"/bin/sh",
			"-c",
			String.raw`printf "%s" "$1" >&2; IFS= read -rs v; printf "\n" >&2; printf "%s" "$v"`,
			"sh",
			prompt,
		],
		{ stderr: "inherit", stdin: "inherit", stdout: "pipe" },
	)
	return r.stdout.toString()
}

/** Read a line from the terminal, visibly. */
export function readLine(prompt: string): string {
	const r = Bun.spawnSync(["/bin/sh", "-c", 'printf "%s" "$1" >&2; IFS= read -r v; printf "%s" "$v"', "sh", prompt], {
		stderr: "inherit",
		stdin: "inherit",
		stdout: "pipe",
	})
	return r.stdout.toString()
}
