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
bash bin/status.sh        # quick table: active, enabled, restart counts
sudo bash bin/reboot-check.sh   # full behavioural check after a reboot
bash bin/lint-vars.sh     # unbound variables in the scripts themselves
```

Every step is idempotent. Running the whole sequence again on a working
machine should change nothing.

### Formatting

Shell scripts are formatted with [`shfmt`](https://github.com/mvdan/sh).
The settings live in `.editorconfig` — four-space indent, indented
`case` bodies, operators at the start of a continuation line — so no
flags are needed:

```bash
shfmt -w bin/*.sh libexec/*.sh
```

`bin/lint-vars.sh` is a different check: it finds variables used but
never assigned, which under `set -u` are runtime crashes.

## Applying

Build order matters, because each step needs something the previous one
left behind.

```bash
# 1. secrets and configuration
sudo bash bin/10-secrets.sh            # credential store
sudo bash bin/12-lnd-wallet.sh         # wallet password where lnd wants it
sudo bash bin/14-lnd-creds.sh          # bitcoind RPC credentials, lnd.conf
sudo bash bin/16-radicle-passphrase.sh # radicle keystore passphrase

# 2. the web root
sudo bash bin/20-caddy.sh              # Caddyfile, caddy binary, token
sudo bash bin/22-caddy-webroot.sh      # /var/www layout and path rewrites

# 3. units
sudo bash bin/30-install.sh --apply    # units, helpers, lnbits extraction

# 4. SELinux, which needs the units and the web root to exist first
sudo bash bin/40-selinux.sh

# 5. retire the old supervisors and open the firewall permanently
sudo bash bin/50-retire.sh

# 6. bring it up
sudo bash bin/60-enable-all.sh
```

`30-install.sh` installs and reloads but does **not** start or enable
anything, so that the first run can be watched one unit at a time.
`60-enable-all.sh` does the enabling, in dependency order.

Start order matters: **bitcoind → lnd → lnbits/albyhub**, then the apps,
then caddy last (it reverse-proxies all of them).

`40-selinux.sh` is the only script that touches SELinux policy, and
everything it does is persistent. It must run **after** `30-install.sh`
and `22-caddy-webroot.sh`, because it reads `EnvironmentFile=` out of the
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

`bin/50-retire.sh` removes all of these.

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
stale duplicate to keep in sync. `bin/22-caddy-webroot.sh` creates the
layout and rewrites the paths inside the Caddyfile; `bin/40-selinux.sh`
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

`bin/40-selinux.sh` works the ports out of the Caddyfile and labels
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

  `bin/40-selinux.sh` relabels them. It does not weaken the policy:
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
(or the TPM2 chip, if present). `bin/10-secrets.sh` creates them.

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
denied". `bin/10-secrets.sh` writes a plain-file fallback for the
RCON password for exactly this reason.

The LND wallet password deliberately avoids that machinery: lnd wants a file
at a fixed path, so `bin/12-lnd-wallet.sh` decrypts the credential to
`/home/heliodex/.lnd/wallet-password` (0400, owned by heliodex) and lnd
reads it with `--wallet-unlock-password-file`. The PaperMC RCON password
works the same way, with a plain-file fallback in `mc-stop.sh`.

If there is no TPM2, `/var/lib/systemd/credential.secret` must be backed up,
or the credentials become unreadable.

The bitcoind RPC password was in two plaintext places: on the `lnd` command
line in `/usr/sbin/lnd.sh`, and in `/srv/hdd/.bitcoin/bitcoin.conf`. Move it
to `lnd.conf` and a systemd credential.

The LND wallet password is needed by lnd at a fixed path for
`--wallet-unlock-password-file`. `bin/12-lnd-wallet.sh` decrypts the
credential and writes that file (`heliodex:heliodex`, 0400).

The Netlify API token was inline in the Caddyfile. It now lives in
`/etc/caddy/netlify.token` (root:caddy, 0640) and is passed to Caddy as
`{$NETLIFY_API_TOKEN}` via `EnvironmentFile`.

The PaperMC RCON password is a credential, consumed by
`libexec/mc-stop.sh` so the server can be stopped cleanly rather than
killed. RCON must be enabled in `server.properties` for this to work.

## Checking it

```bash
bash bin/status.sh              # a summary table: active, enabled, restarts
sudo bash bin/reboot-check.sh   # behaviour, after a reboot
```

`status.sh` is the quick look. `reboot-check.sh` is the real test: it
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
