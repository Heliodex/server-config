# server-config

Declarative systemd configuration for `opensuseserver` (openSUSE Tumbleweed).

Everything here is applied to the server by copying files into place, not by
a configuration management tool. The git repo is the source of truth; the
server's `/etc/systemd/system` is a copy of it.

## Layout

```
systemd/system/     → /etc/systemd/system   (unit files and slices)
systemd/user/       → ~/.config/systemd/user (user units)
libexec/            → /usr/local/libexec    (helper scripts)
etc/                → /etc/                 (Caddyfile and friends)
bin/                → scripts, run on the server
state/captured/     → the units as they were before the migration (reference)
out/                → script output (gitignored)
```

## Scripts

The numbered scripts **are** the build, in order. Each depends on the
ones before it, so they are meant to be read and run top to bottom.

| Range | What it sets up |
|---|---|
| `10`–`19` | secrets and credentials |
| `20`–`29` | the web root caddy serves |
| `30`–`39` | the units themselves |
| `40`–`49` | SELinux policy |
| `50`–`59` | taking the old supervisors out |
| `60`–`69` | starting it |

The unnumbered ones are tools rather than steps, and can be run at any
time:

```bash
bun bin/status.ts       # quick table: active, enabled, restart counts
bun bin/reboot-check.ts # full behavioural check after a reboot
bun bin/lint-vars.ts    # unbound variables in the remaining shell helpers
```

Every step is idempotent. Running the whole sequence again on a working
machine should change nothing.

### Formatting

The TypeScript is formatted by `biome`, through `bun lint:fix`. The two
shell helpers left in `libexec/` are formatted with
[`shfmt`](https://github.com/mvdan/sh), whose settings live in
`.editorconfig` — tab indent, indented `case` bodies, operators at the
start of a continuation line — so no flags are needed:

```bash
shfmt -w libexec/*.sh
```

`bin/lint-vars.ts` is a different check again: it finds variables used
but never assigned, which under `set -u` are runtime crashes. It now
only has `libexec/` to look at, which is still worth guarding because
`mc-stop.sh` is what stops the Minecraft server.

### Why TypeScript

The scripts are TypeScript run by Bun. They elevate themselves, so no
`sudo` is needed and `sudo`'s `PATH` cannot lose Bun:

```bash
bun bin/status.ts
bun bin/40-selinux.ts
```

What that buys is not brevity. Measured before the shell versions were
removed, code only and comments excluded: **1391 lines of bash became
1366 of TypeScript**, two percent shorter. Where it did win was loops,
tables and error handling:

| Script | bash | TS |
|---|---|---|
| `reboot-check` | 246 | 213 |
| `10-secrets` | 120 | 97 |
| `30-install` | 148 | 132 |
| `16-radicle-passphrase` | 53 | 40 |
| `lint-vars` | 89 | 114 |
| `20-caddy` | 84 | 95 |
| `40-selinux` | 115 | 123 |
| **all thirteen** | **1391** | **1366** |

The value is elsewhere:

* **Failure is loud.** Bash printed an error and carried on; `await` on a
  non-zero exit throws unless told otherwise. Most of the long evening
  that produced this repo was silent failures of that kind - a `chmod`
  that did not happen, an `EnvironmentFile` that systemd could not read,
  a `cmp` that never ran.
* **It is checked before it runs.** `bun check` found ten type errors that
  both linters passed, all of them real: an unchecked array index, an
  optional regex group added to a `Set`. The shell scripts had no such
  check, which is how `20-caddy.sh` compared the wrong field of `ls -Z`
  for months and relabelled every run.
* **No quoting discipline.** `` $`cmd ${value}` `` passes `value` as one
  escaped argument. The shell versions were full of `"$var"` and the
  occasional forgotten quote.
* **One place for the shared parts.** `bin/_lib.ts` holds the root check,
  section headings, aligned output and the hidden-input prompt.

The cost is anything that was a shell pipeline. `lint-vars` grew the most
because a script about shell quoting has to reimplement that quoting in
TypeScript; `20-caddy` and `40-selinux` grew on `grep`/`sed`/`find`
rebuilt from regexes and globs.

The shell versions are still in history, at `3e1e422`:

```bash
git show 3e1e422:bin/40-selinux.sh
```

### Linting

```bash
bun check       # Bun's built-in type checker
bun lint        # oxlint (type-aware) and biome, warnings count as errors
bun lint:fix    # apply both fixers
```

The three are not redundant. `bun check` type-checks against `tsconfig.json`
and catches what the linters let through — with `noUncheckedIndexedAccess`
on, a regex capture group is `string | undefined`, which oxlint accepts and
the type checker does not. `oxlint` catches style and safety rules; `biome`
formats.

`tsconfig.json` is what lets the type-aware pass resolve `bun`; without it
every `$` template is reported as an error type. `biome.json` also formats
and sorts. `libexec/` is excluded from oxlint, because the RCON client is
plain JavaScript that cannot satisfy the unsafe-* rules without types, and
its fixer rewrites it into worse code than it started as.

## Applying

Build order matters, because each step needs something the previous one
left behind.

```bash
# 1. secrets and configuration
bun bin/10-secrets.ts            # credential store
bun bin/12-lnd-wallet.ts         # wallet password where lnd wants it
bun bin/14-lnd-creds.ts          # bitcoind RPC credentials, lnd.conf
bun bin/16-radicle-passphrase.ts # radicle keystore passphrase

# 2. the web root
bun bin/20-caddy.ts              # Caddyfile, caddy binary, token
bun bin/22-caddy-webroot.ts      # /var/www layout and path rewrites

# 3. units
bun bin/30-install.ts --apply    # units, helpers, lnbits extraction

# 4. SELinux, which needs the units and the web root to exist first
bun bin/40-selinux.ts

# 5. retire the old supervisors and open the firewall permanently
bun bin/50-retire.ts

# 6. bring it up
bun bin/60-enable-all.ts
```

`30-install.ts` installs and reloads but does **not** start or enable
anything, so that the first run can be watched one unit at a time.
`60-enable-all.ts` does the enabling, in dependency order.

Start order matters: **bitcoind → lnd → lnbits/albyhub**, then the apps,
then caddy last (it reverse-proxies all of them).

`40-selinux.ts` is the only script that touches SELinux policy, and
everything it does is persistent. It must run **after** `30-install.ts`
and `22-caddy-webroot.ts`, because it reads `EnvironmentFile=` out of the
installed units and labels the trees behind the `/var/www` symlinks.

## The service map

| Service | Unit | User | Notes |
|---|---|---|---|
| Bitcoin Core | `bitcoind.service` | heliodex | datadir on `/srv/hdd/.bitcoin` |
| LND | `lnd.service` | heliodex | `Type=notify`, unlocks its own wallet via `--wallet-unlock-password-file` |
| LNBits | `lnbits.service` | heliodex | requires `lnd.service` |
| Alby Hub | `albyhub.service` | heliodex | requires `lnd.service` |
| Caddy | `caddy.service` | caddy | config at `/etc/caddy/Caddyfile` |
| Radicle node | `radicle-node.service` | heliodex | was `User=seed`, which did not exist |
| Radicle httpd | `radicle-httpd.service` | heliodex | |
| Peaks | `peaks.service` | heliodex | replaces pm2; starts its own SurrealDB |
| Mercury Core | `mercury-core.service` | mercury | replaces pm2; starts its own SurrealDB |
| Defector | `defector.service` | heliodex | replaces GNU Screen; starts its own SurrealDB |
| Coputer gateway | `coputer-gateway@.service` | heliodex | listens on 2517, matches subdomains of its arg |
| Coputer wallflower | `coputer-wallflower@.service` | heliodex | 2506/2507, needs `cosec` in its cwd |
| Coputer litecode | `coputer-litecode.service` | heliodex | 2505 |
| Urbit | `urbit.service` | heliodex | pier at `~/urbit/rinmex-ritlys` |
| PaperMC | `paper@.service` | heliodex | jar `paper-26.1.2-61.jar`, graceful stop via RCON |
| Agent sandbox | `opencode.container` (podman quadlet) | heliodex | user unit, unchanged |

SurrealDB is deliberately not managed here. Each app starts and manages its
own instance, on its own port, with its own auth. Consolidating to one
instance with three namespaces means migrating the per-app `data/surreal`
directories, which is a separate piece of work.

## Retired

- `startup.service` — only ran four `firewall-cmd --add-port` calls, and
  without `--permanent` they did not survive a firewalld restart. Replaced
  by permanent firewalld rules.
- `gateway.service`, `litecode.service`, `wallflower.service` — stale
  copies of the coputer units, superseded by the ones above.
- `t3code.service` — unused. The agent sandbox is the podman quadlet.
- pm2 — `bunx pm2` downloaded pm2 on every invocation, which cannot work at
  boot without network access, and the process tree was invisible to
  systemd. Every pm2 app now has a real unit.
- GNU Screen — same problem, plus no restart policy.

`bin/50-retire.ts` removes all of these.

## The web root

Caddy runs in the `httpd_t` SELinux domain, which may not read files under
a user's home. The configuration and the served trees therefore live under
`/var/www`:

```
/var/www/Caddyfile                    the configuration
/var/www/radicle-explorer -> ~/radicle-explorer/build
/var/www/mercury-setup    -> ~/setup
/var/www/mercury-site     -> ~/MercuryCore/Site
/var/www/minecraft        -> ~/minecraft
/var/www/fileserver       -> /srv/ssd/_fileserver
```

The served trees are symlinks, so the data has one home and there is no
stale duplicate to keep in sync. `bin/22-caddy-webroot.ts` creates the
layout and rewrites the paths inside the Caddyfile; `bin/40-selinux.ts`
labels the files behind the symlinks, since SELinux resolves a link and
applies the target's label.

## Ports

Every service gets a port of its own, and no service takes a default
that another one also wants. The ones that clashed:

| Service | Port | Note |
|---|---|---|
| caddy | 80, 443, 8030 | 8030 is the albyhub site |
| lnd | 10009 (gRPC), 18080 (REST) | REST moved off urbit's 8080 |
| urbit | 8080 | pinned with `--http-port`, the Caddyfile proxies to it |
| peaks | 6511 | |
| defector | 3000 | |
| radicle-httpd | 8775 | |
| radicle-node | 8776 | |
| bitcoin | 8332 (RPC, local) | P2P not opened inbound |

`httpd_t` may only bind ports labelled `http_port_t`, so a port caddy
needs has to be labelled:

```bash
sudo semanage port -a -t http_port_t -p tcp 8030
```

`bin/40-selinux.ts` works the ports out of the Caddyfile and labels
them.

## SELinux

The box is booted with `security=selinux selinux=1` and SELinux is
enforcing. Two consequences for units:

- **A binary that systemd execs directly must be labelled `bin_t`.** Files
  under `$HOME` are `user_home_t`, and `init_t` may not execute those:

  ```
  denied { execute } for pid=1187 comm="(litecode)" name="litecode"
    scontext=system_u:system_r:init_t:s0
    tcontext=unconfined_u:object_r:user_home_t:s0
  ```

  `bin/40-selinux.ts` relabels them. It does not weaken the policy:
  `bin_t` is the correct label for an executable, and the rule permitting
  `init_t` to execute `bin_t` is already there. It only stops SELinux
  treating a program as user data.

  This applies to a **symlink** too: `/usr/bin/radicle-node` looked
  correct, but it pointed into `$HOME`, and SELinux applies the target's
  label.

- **Caddy**, in `httpd_t`, may not read `$HOME` either. Hence the web root
  above.

## Secrets

Nothing secret is committed. The `systemd-creds` blobs live in
`/etc/credstore.encrypted/` on the server and are encrypted to the host key
(or the TPM2 chip, if present). `bin/10-secrets.ts` creates them.

The naming has to satisfy two different checks, so the embedded name, the
filename and the unit's credential ID are all the same string, with no
extension:

```
/etc/credstore.encrypted/lnd-wallet-pass
LoadCredentialEncrypted=lnd-wallet-pass:/etc/credstore.encrypted/lnd-wallet-pass
```

`systemd-creds decrypt` validates the embedded name against the *basename*;
the service manager validates it against the *ID*. A `.cred` suffix on the
filename makes those two disagree, and the credential is refused.

There is a second, unrelated failure mode: systemd mounts a tmpfs for the
credentials directory, and that needs kernel 5.12+. Where the mount is
unavailable, every unit using `LoadCredential=` or `LoadCredentialEncrypted=`
dies with `243/CREDENTIALS` and "Failed to set up credentials: Permission
denied". `bin/10-secrets.ts` writes a plain-file fallback for the
RCON password for exactly this reason.

The LND wallet password deliberately avoids that machinery: lnd wants a file
at a fixed path, so `bin/12-lnd-wallet.ts` decrypts the credential to
`/home/heliodex/.lnd/wallet-password` (0400, owned by heliodex) and lnd
reads it with `--wallet-unlock-password-file`. The PaperMC RCON password
works the same way, with a plain-file fallback in `mc-stop.sh`.

If there is no TPM2, `/var/lib/systemd/credential.secret` must be backed up,
or the credentials become unreadable.

The bitcoind RPC password was in two plaintext places: on the `lnd` command
line in `/usr/sbin/lnd.sh`, and in `/srv/hdd/.bitcoin/bitcoin.conf`. Move it
to `lnd.conf` and a systemd credential.

The LND wallet password is needed by lnd at a fixed path for
`--wallet-unlock-password-file`. `bin/12-lnd-wallet.ts` decrypts the
credential and writes that file (`heliodex:heliodex`, 0400).

The Netlify API token was inline in the Caddyfile. It now lives in
`/etc/caddy/netlify.token` (root:caddy, 0640) and is passed to Caddy as
`{$NETLIFY_API_TOKEN}` via `EnvironmentFile`.

The PaperMC RCON password is a credential, consumed by
`libexec/mc-stop.sh` so the server can be stopped cleanly rather than
killed. RCON must be enabled in `server.properties` for this to work.

## Checking it

```bash
bun bin/status.ts              # a summary table: active, enabled, restarts
bun bin/reboot-check.ts   # behaviour, after a reboot
```

`status.ts` is the quick look. `reboot-check.ts` is the real test: it
waits for the boot to finish, then checks that each service is *listening*
rather than merely active, that lnd's wallet unlocked, that caddy has
certificates, that `/srv/hdd` is mounted, and that the firewall rules and
the SELinux boolean survived. A service can be `active` and still be
broken, which is the distinction that matters.

Output lands in `out/`. That directory is gitignored because it can
contain secrets in captured unit files and config.

Note: `heliodex` needs to be in the `systemd-journal` group to read the
system journal. Without it, `journalctl -u <unit>` silently returns nothing
and failures are invisible.
