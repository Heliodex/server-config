#!/usr/bin/env bun
// bin/lint-vars.ts — find variables used but never assigned.
//
// Run:  bun bin/lint-vars.ts
//
// Under `set -u` a variable that is used but never assigned is a runtime crash that only appears when the script reaches that line, which is how two of them got into these scripts.
//
// The check is deliberately rough: it reports names it cannot account for, so a few false positives are possible, but it catches the real class of bug. It skips heredoc bodies, single-quoted strings, escaped dollars and whole-line comments, because a $name in any of those is text rather than an expansion.

import { REPO } from "./_lib.ts"

const files: string[] = []
for (const dir of ["bin", "libexec"])
	for await (const name of new Bun.Glob("*.sh").scan({ cwd: `${REPO}/${dir}` })) files.push(`${dir}/${name}`)

const sorted = files.toSorted()

const KNOWN = new Set([
	"BASH_SOURCE",
	"HOME",
	"USER",
	"PATH",
	"PWD",
	"IFS",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"@",
	"*",
	"#",
	"?",
	"!",
	"-",
])

/** Strip the bodies of heredocs: their text is literal, not code. */
function withoutHeredocs(source: string): string[] {
	const result: string[] = []
	let terminator: string | null = null

	for (const line of source.split("\n")) {
		if (terminator) {
			if (line.trim() === terminator) terminator = null
			continue
		}
		const start = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
		// A '#' line cannot start a heredoc, so keep comments in the stream.
		const heredocEnd = start?.[2]
		if (heredocEnd && !line.trimStart().startsWith("#")) terminator = heredocEnd

		result.push(line)
	}
	return result
}

/** Names the file assigns, from any of the shapes bash uses. */
function assignedNames(lines: string[]): Set<string> {
	const names = new Set<string>()

	for (const line of lines) {
		// local/export/plain assignments, including the second and later names in `local a=1 b=2`
		for (const m of line.matchAll(/(?:^|\s)(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/g)) {
			const name = m[1]
			if (name) names.add(name)
		}

		// for loop variables
		for (const m of line.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
			const name = m[1]
			if (name) names.add(name)
		}
		// read targets, which may be several, and may follow a pipe
		const read = /\bread\s+(.*)$/.exec(line)
		if (read) {
			let rest = read[1] ?? ""
			rest = rest.replaceAll(/^-[a-zA-Z]+\s+/g, "")
			rest = rest
				.replace(/<<<.*$/, "")
				.replace(/<.*$/, "")
				.replace(/;.*$/, "")
				.replace(/\s+do\s*$/, "")
			for (const token of rest.trim().split(/\s+/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) names.add(token)
		}
		// ${VAR:-default} and friends are safe under set -u
		for (const m of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-|:=|:\+)/g)) {
			const name = m[1]
			if (name) names.add(name)
		}
	}
	return names
}

/** Drop the literal parts of a line, keeping only what actually expands. A single quote makes everything literal until the closing one, and a backslash escapes the next character. Double quotes do NOT stop expansion, so their contents stay. This has to be a scanner rather than a set of regexes: stripping quoted spans with a regex happily matches from the end of one string to the start of the next, which glued `"$a"; [ -e "$b" ]` into `$a$b` and invented variable names. */

function stripLiterals(line: string): string {
	let out = ""
	let quote: '"' | "'" | null = null

	for (let i = 0; i < line.length; i++) {
		const c = line[i]

		if (c === "\\") {
			i++ // the escaped character is literal
			continue
		}
		if (quote === "'") {
			if (c === "'") quote = null
			continue
		}
		if (quote === '"') {
			if (c === '"') {
				quote = null
				continue
			}
			out += c
			continue
		}
		if (c === "'" || c === '"') {
			quote = c
			continue
		}
		out += c
	}
	return out
}

/** Every $name or ${name} that is a real expansion, not literal text. */
function usedNames(lines: string[]): Set<string> {
	const names = new Set<string>()

	for (const raw of lines) {
		if (raw.trimStart().startsWith("#")) continue
		const line = stripLiterals(raw)

		for (const m of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
			const name = m[1]
			if (name && !KNOWN.has(name)) names.add(name)
		}
	}
	return names
}

/** A '[' test whose closing ']' is missing is not caught by bash -n. */
function missingBracket(line: string): boolean {
	if (!/^\s*\[/.test(line)) return false
	if (!/(-eq|-ne|-lt|-gt|-ge|-le)\s/.test(line)) return false
	return !line.includes("]")
}

let fail = 0

for (const file of sorted) {
	const source = await Bun.file(`${REPO}/${file}`).text()
	const lines = withoutHeredocs(source)

	const assigned = assignedNames(lines)
	const used = usedNames(lines)

	for (const name of [...used].toSorted()) {
		if (assigned.has(name)) continue
		console.log(`  ${file.padEnd(32)} $${name} used but never assigned`)
		fail = 1
	}

	for (const line of lines)
		if (missingBracket(line)) {
			console.log(`  ${file.padEnd(32)} test with a missing ]: ${line.trim()}`)
			fail = 1
		}
}

if (fail === 0) console.log("no unbound variables found")
process.exit(fail)
