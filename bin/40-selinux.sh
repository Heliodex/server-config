#!/usr/bin/env bash
# bin/40-selinux.sh — all of the SELinux configuration this box needs.
#
# Run:  sudo bash bin/40-selinux.sh
#
# This is the only script that changes SELinux policy, and everything it does is persistent: it writes fcontext rules (which survive a relabel and a reboot), port labels, and one boolean. Nothing here is a diagnostic.
#
# It replaces four overlapping scripts that each did part of this and were scattered through the numbering for no good reason.
#
# THE FOUR THINGS THAT GO WRONG ON THIS BOX
# -----------------------------------------
# 1. A binary systemd execs directly must be bin_t. Files under $HOME are user_home_t, and init_t may not execute those:
#
#      denied { execute } for pid=1187 comm="(litecode)" name="litecode"
#        scontext=system_u:system_r:init_t:s0
#        tcontext=unconfined_u:object_r:user_home_t:s0
#
# The same applies through a symlink: /usr/bin/radicle-node pointed into $HOME and was denied, because SELinux applies the target's label.
#
# 2. caddy is the exception. It must be httpd_exec_t, not bin_t, because that is what gives the process the httpd_t domain it needs to serve web content.
#
# 3. httpd_t may only bind ports labelled http_port_t, and may not open outbound connections unless httpd_can_network_connect is on. Both failures look identical from outside - "permission denied" on a bind, or no certificates ever being issued.
#
# 4. systemd reads EnvironmentFile= itself, as init_t, before dropping to the service's user. A .env file under $HOME is user_home_t and cannot be read, and because the units use EnvironmentFile=- the failure is silent: the service starts with an empty environment.
set -uo pipefail

export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

if [ "$(id -u)" -ne 0 ]; then
	echo "must run as root" >&2
	exit 1
fi

if ! command -v semanage >/dev/null 2>&1; then
	echo "!! semanage is not installed" >&2
	echo "   sudo zypper install policycoreutils-python-utils" >&2
	exit 1
fi

echo "== SELinux =="
getenforce 2>&1 | sed 's/^/  /'

# stat -c %C prints the context directly. Parsing "ls -Z" needs care:
# its output is "<context> <path>", so field 2 is the path, not the type, and an earlier version of this script silently compared the path to the word "bin_t" and always relabelled.
type_of() {
	stat -c '%C' "$1" 2>/dev/null | awk -F: '{print $3}'
}

# label_file PATH TYPE [FCONTEXT-PATTERN]
# The pattern is what gets written into the persistent rule; the path is what gets relabelled now. They differ for things like versioned directories, where every version should match.
label_file() {
	local path="$1" want="$2" pattern="${3:-$2}"

	if [ ! -e "$path" ]; then
		printf '  %-52s absent\n' "$path"
		return
	fi

	local now
	now=$(type_of "$path")
	if [ "$now" = "$want" ]; then
		printf '  %-52s already %s\n' "$path" "$want"
		return
	fi

	# -a adds; if a rule for that pattern already exists, -m modifies it.
	semanage fcontext -a -t "$want" "$pattern" 2>/dev/null \
		|| semanage fcontext -m -t "$want" "$pattern" 2>/dev/null \
		|| true
	restorecon "$path" 2>/dev/null || true

	printf '  %-52s %s -> %s\n' "$path" "${now:-?}" "$(type_of "$path")"
}

echo
echo "== 1. binaries that systemd executes directly: bin_t =="

# bitcoind, from a versioned directory, so the rule is a pattern and the path is whichever version is installed.
BITCOIND=$(find /home/heliodex/bitcoin -maxdepth 3 -name bitcoind -type f 2>/dev/null | sort | tail -1)
[ -n "$BITCOIND" ] && label_file "$BITCOIND" bin_t '/home/heliodex/bitcoin/[^/]*/bin/bitcoind'

label_file /home/heliodex/.bun/bin/bun bin_t
label_file /home/heliodex/urbit/urbit bin_t
label_file /home/heliodex/lightning/lnd bin_t
label_file /home/heliodex/albyhub/bin/albyhub bin_t

# The extracted lnbits AppImage. Its sibling files stay as they are; only the entry point is executed.
label_file /opt/lnbits/squashfs-root/usr/lnbits/dist/lnbits bin_t

# Radicle installs into $HOME and /usr/bin/radicle-node is a symlink to it, so the target is what needs the label.
for f in /home/heliodex/.radicle/bin/radicle-node \
	/home/heliodex/.radicle/bin/rad /home/heliodex/.radicle/bin/git-remote-rad; do
	label_file "$f" bin_t
done

# The coputer trio are symlinks from /usr/bin into $HOME.
for b in gateway litecode wallflower; do
	real=$(readlink -f "/usr/bin/$b" 2>/dev/null)
	[ -n "$real" ] && label_file "$real" bin_t
done

# Mercury's Economy service, which Mercury Core spawns as a subprocess.
while IFS= read -r f; do
	label_file "$f" bin_t
done < <(find /home/mercury/MercuryCore/Economy -maxdepth 2 -type f -perm -u+x 2>/dev/null)

echo
echo "== 2. caddy: httpd_exec_t, not bin_t =="
# httpd_exec_t is what gives the process the httpd_t domain. bin_t would let systemd execute it but the process would stay in init_t, which is not what reads a web root.
label_file /usr/local/bin/caddy httpd_exec_t

echo
echo "== 3. what httpd_t may do =="

printf '  %-52s ' "httpd_can_network_connect"
if [ "$(getsebool httpd_can_network_connect 2>/dev/null | awk '{print $3}')" = "on" ]; then
	echo "already on"
else
	setsebool -P httpd_can_network_connect 1 2>&1 | sed 's/^/    /'
	echo "turned on (persistent)"
fi
echo "  (without it caddy cannot reach Let's Encrypt, so no certificates)"

# Only the ports caddy BINDS matter: those in a site address, not the reverse_proxy targets and not the numbers inside IP addresses.
CADDYFILE=/var/www/Caddyfile
if [ -f "$CADDYFILE" ]; then
	PORTS=$(grep -E '^[[:space:]]*(https?://)?[^[:space:]]*:[0-9]{2,5}[[:space:]]*\{' "$CADDYFILE" 2>/dev/null \
		| grep -oE ':[0-9]{2,5}' | tr -d ':' | sort -un)
	# The named sites bind 443 for TLS and 80 for the redirect whether or not those are written out.
	PORTS=$(printf '%s\n80\n443\n' "$PORTS" | sort -un | grep -E '^[0-9]+$')

	echo
	for p in $PORTS; do
		printf '  tcp/%-8s ' "$p"
		if semanage port -l 2>/dev/null | grep -E '^http_port_t' | grep -qw "$p"; then
			echo "already http_port_t"
		else
			semanage port -a -t http_port_t -p tcp "$p" 2>/dev/null \
				|| semanage port -m -t http_port_t -p tcp "$p" 2>/dev/null \
				|| true
			echo "labelled http_port_t"
		fi
	done
else
	echo
	echo "  $CADDYFILE not found, skipping port labels (bin/20-caddy.sh)"
fi

echo
echo "== 4. the files systemd reads itself: etc_t =="

# EnvironmentFile= is read by PID 1 as init_t, so a .env under $HOME is unreadable and the service silently starts with no environment. This walks the installed units rather than a hardcoded list, so a unit added later is covered.
# Every one of them is labelled, including the ones under /etc: a file there is not automatically readable by init_t. /etc/caddy/netlify.env picks up httpd_sys_content_t from the policy for that directory, and that is the label that silently stopped the Netlify token from reaching caddy. etc_t is the type /etc is for, and init_t can read it.
while IFS= read -r envfile; do
	envfile="${envfile#-}"
	label_file "$envfile" etc_t
done < <(grep -hoE '^EnvironmentFile=-?.*' /etc/systemd/system/*.service 2>/dev/null \
	| sed 's/^EnvironmentFile=//' | tr ' ' '\n' | grep -E '^/' | sort -u)

echo
echo "== 5. what caddy serves: httpd_sys_content_t =="

# The web root is /var/www and the served trees are symlinks into $HOME.
# SELinux resolves a symlink and applies the target's label, so the target is what has to be labelled.
label_file /var/www/Caddyfile httpd_sys_content_t

while IFS= read -r link; do
	target=$(readlink -f "$link" 2>/dev/null)
	[ -n "$target" ] && [ -d "$target" ] || continue
	label_file "$target" httpd_sys_content_t "$target(/.*)?"
done < <(find /var/www -maxdepth 1 -type l 2>/dev/null)

echo
echo "== result =="
for f in "$BITCOIND" /usr/local/bin/caddy /home/heliodex/.bun/bin/bun /home/heliodex/urbit/urbit; do
	[ -n "${f:-}" ] || continue
	printf '  %-52s %s\n' "$f" "$(type_of "$f")"
done
printf '  %-52s %s\n' "httpd_can_network_connect" "$(getsebool httpd_can_network_connect 2>/dev/null | awk '{print $3}')"

echo
echo "Now restart anything whose label changed:"
echo "  sudo bash bin/30-install.sh --apply && sudo bash bin/60-enable-all.sh"
echo
echo "=== DONE ==="
