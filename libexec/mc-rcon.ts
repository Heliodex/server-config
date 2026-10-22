#!/usr/bin/env bun
// libexec/mc-rcon.ts — send a command to a Minecraft server over RCON.
//
// Used by libexec/mc-stop.sh. Implements the RCON protocol directly, so
// there is no dependency on mcrcon, which is not packaged for openSUSE.
//
// The password comes from a file path in argv, not from argv itself, so it
// never appears in the process list.
//
//   bun mc-rcon.ts <host> <port> <password-file> <command>
//
// Failure here is not fatal: paper@.service also sets KillSignal=SIGTERM
// and TimeoutStopSec, and Paper saves the world on SIGTERM anyway.

import { readFile } from "node:fs/promises"
import net from "node:net"

const host = process.argv[2] ?? "127.0.0.1"
const port = Number(process.argv[3] ?? 25575)
const passwordFile = process.argv[4]
const command = process.argv[5] ?? "stop"

if (!passwordFile) {
	console.error("mc-rcon: no password file given")
	process.exit(2)
}

const password = (await readFile(passwordFile, "utf8")).trim()

/** A reply from the server: an id and a packet type, with the body ignored. */
interface Packet {
	id: number
	type: number
}

// RCON packet:
//   int32 length  - size of everything after this field
//   int32 id
//   int32 type     - 3 = auth, 2 = exec command
//   body          - null-terminated UTF-8 plus one padding null
// so length = 4 (id) + 4 (type) + strlen + 2 (the two nulls).
function encode(id: number, type: number, body: string): Buffer {
	const text = Buffer.from(body, "utf8")
	const length = text.length + 10
	const buf = Buffer.alloc(length + 4)
	buf.writeInt32LE(length, 0)
	buf.writeInt32LE(id, 4)
	buf.writeInt32LE(type, 8)
	text.copy(buf, 12)
	buf[12 + text.length] = 0
	buf[12 + text.length + 1] = 0
	return buf
}

// Types
const AUTH = 3
const AUTH_RESPONSE = 2
const EXEC_COMMAND = 2
const RESPONSE_VALUE = 0

/** Buffers whatever arrives, so exact byte counts can be pulled from it. */
class Reader {
	private buf = Buffer.alloc(0)
	private waiter: (() => void) | null = null
	private ended = false

	constructor(sock: net.Socket) {
		sock.on("data", (chunk: Buffer) => {
			this.buf = Buffer.concat([this.buf, chunk])
			this.wake()
		})
		sock.on("end", () => {
			this.ended = true
			this.wake()
		})
		sock.on("error", () => {
			this.ended = true
			this.wake()
		})
	}

	private wake(): void {
		if (this.waiter) {
			const w = this.waiter
			this.waiter = null
			w()
		}
	}

	async exact(n: number): Promise<Buffer> {
		while (this.buf.length < n) {
			if (this.ended) throw new Error("connection closed")
			await new Promise<void>(resolve => {
				this.waiter = resolve
			})
		}
		const out = this.buf.subarray(0, n)
		this.buf = this.buf.subarray(n)
		return out
	}

	async packet(): Promise<Packet> {
		const length = (await this.exact(4)).readInt32LE(0)
		if (length < 10 || length > 1024 * 1024) throw new Error(`bad packet length ${length}`)
		const body = await this.exact(length)
		return { id: body.readInt32LE(0), type: body.readInt32LE(4) }
	}
}

const sock = net.connect({ host, port })
sock.setTimeout(15000)

try {
	await new Promise<void>((resolve, reject) => {
		sock.once("connect", resolve)
		sock.once("error", reject)
		sock.once("timeout", () => reject(new Error("connection timed out")))
	})

	const reader = new Reader(sock)

	// Auth. The server replies with the same id on success, -1 on failure.
	// It may send a value packet first, so skip those.
	sock.write(encode(1, AUTH, password))

	let auth = await reader.packet()
	while (auth.type !== AUTH_RESPONSE) {
		if (auth.type !== RESPONSE_VALUE) throw new Error(`unexpected packet type ${auth.type}`)
		auth = await reader.packet()
	}

	if (auth.id === -1) {
		console.error("mc-rcon: authentication failed")
		process.exit(1)
	}

	// Execute the command. The server answers with a value packet.
	sock.write(encode(2, EXEC_COMMAND, command))
	await reader.packet()

	console.log(`mc-rcon: '${command}' sent`)
} catch (err) {
	console.error(`mc-rcon: ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
} finally {
	sock.end()
}
