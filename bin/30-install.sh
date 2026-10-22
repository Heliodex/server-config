#!/usr/bin/env bash
# bin/30-install.sh — install the tracked systemd units onto this server.
#
# Run:  bash bin/30-install.sh          (dry run, prints what it would do)
# bash bin/30-install.sh --apply  (actually does it)
#
# Requires: root. Installs units from systemd/system/ into /etc/systemd/system.
# Does NOT start or enable anything — that is a separate, deliberate step.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname -- "$SCRIPT_DIR")"
SRC="$REPO_DIR/systemd/system"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ "$(id -u)" -eq 0 ] || {
    echo "must run as root"
    exit 1
}

fail=0

if [ "$APPLY" -eq 1 ]; then
    run() {
        echo "  $*"
        if ! "$@"; then
            echo "  !! FAILED: $*" >&2
            fail=1
        fi
    }
else
    run() { echo "  $*"; }
fi

echo "== source: $SRC"

# ---------------------------------------------------------------- units
echo
echo "== installing unit files"
install -d -m 0755 /etc/systemd/system
for f in "$SRC"/*.service "$SRC"/*.slice "$SRC"/*.timer; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ -e "/etc/systemd/system/$name" ] && ! cmp -s "$f" "/etc/systemd/system/$name"; then
        if [ "$APPLY" -eq 1 ]; then
            cp -a "/etc/systemd/system/$name" "/etc/systemd/system/$name.bak.$(date +%s)"
            echo "  backed up existing $name"
        else
            echo "  would back up existing $name"
        fi
    fi
    run install -Dm644 "$f" "/etc/systemd/system/$name"
done

# drop-in directories (e.g. btrfs-scrub.timer.d/)
for d in "$SRC"/*.d; do
    [ -d "$d" ] || continue
    run install -d -m 0755 "/etc/systemd/system/$(basename "$d")"
    for f in "$d"/*.conf; do
        [ -f "$f" ] || continue
        run install -Dm644 "$f" "/etc/systemd/system/$(basename "$d")/$(basename "$f")"
    done
done

# ------------------------------------------------------------ libexec
echo
echo "== installing helper scripts"
run install -d -m 0755 /usr/local/libexec
for f in "$REPO_DIR"/libexec/*.sh "$REPO_DIR"/libexec/*.js; do
    [ -f "$f" ] || continue
    run install -Dm755 "$f" "/usr/local/libexec/$(basename "$f")"
done

# Verify the helpers actually landed. A missing helper makes every unit that references it fail with a confusing "not executable" error, and it is easy to miss if the install silently failed.
echo
echo "== checking helper scripts"
for f in "$REPO_DIR"/libexec/*.sh "$REPO_DIR"/libexec/*.js; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ -x "/usr/local/libexec/$name" ]; then
        printf '  %-20s installed and executable\n' "$name"
    else
        printf '  %-20s MISSING or not executable\n' "$name"
        fail=1
    fi
done

# ------------------------------------------------- stale property drop-ins
# "systemctl set-property" does not only change the running cgroup, it writes a drop-in under /etc/systemd/system.control/ that persists across reboots and takes precedence over the unit file. Any that are left over mean the slice files in this repo are not actually in charge, which is how apps.slice ended up throttling every app with a MemoryHigh that had been removed from the file months earlier.
echo
echo "== clearing stale set-property drop-ins"
for d in /etc/systemd/system.control/*.slice.d; do
    [ -d "$d" ] || continue
    if compgen -G "$d/*.conf" >/dev/null; then
        echo "  $(basename "$d"):"
        ls -1 "$d" | sed 's/^/    /'
        run rm -f "$d"/*.conf
    fi
done
echo "  (the unit files are the source of truth)"

# ---------------------------------------------------------- appimages
# lnbits-1.1.0 is an AppImage. It needs FUSE, which a service does not have, and its fallback extraction does not work inside the sandbox either. So it is extracted once, here, and the unit runs the extracted AppRun.
#
# This has to happen at install time: the unit refers to the extracted path, and that path has to exist.
echo
echo "== extracting AppImages"
LNBITS_APPIMAGE=/home/heliodex/lightning/lnbits-1.1.0
LNBITS_EXTRACT=/opt/lnbits
if [ -x "$LNBITS_APPIMAGE" ]; then
    if [ -x "$LNBITS_EXTRACT/squashfs-root/AppRun" ]; then
        echo "  lnbits: already extracted"
    else
        echo "  lnbits: extracting (this takes a moment)"
        rm -rf "$LNBITS_EXTRACT"
        install -d -m 0755 "$LNBITS_EXTRACT"
        (cd "$LNBITS_EXTRACT" && "$LNBITS_APPIMAGE" --appimage-extract) >/dev/null 2>&1
        if [ -x "$LNBITS_EXTRACT/squashfs-root/AppRun" ]; then
            chown -R heliodex:heliodex "$LNBITS_EXTRACT"
            # Do NOT chmod the files. --appimage-extract already writes them with the modes recorded in the image, and a blanket chmod 0644 strips the execute bit off the binaries inside.
            # That is exactly what happened: the tree looked complete but usr/lnbits/dist/lnbits was 0644, so running it failed and AppRun fell back to its error loop.
            chmod 0755 "$LNBITS_EXTRACT/squashfs-root/AppRun" 2>/dev/null
            chmod 0755 "$LNBITS_EXTRACT/squashfs-root/usr/lnbits/dist/lnbits" 2>/dev/null
            echo "  lnbits: extracted to $LNBITS_EXTRACT/squashfs-root"
        else
            echo "  !! lnbits: extraction failed" >&2
            fail=1
        fi
    fi
else
    echo "  lnbits: $LNBITS_APPIMAGE not present, skipping"
fi

# ------------------------------------------------------------ validate
echo
echo "== validating"
for f in "$SRC"/*.service "$SRC"/*.slice; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    # Only care about problems in OUR files. systemd-analyze verify also reports issues in packaged units we depend on (plymouth, etc), which are not ours to fix and would otherwise drown out the real signal.
    #
    # It also reports "not executable" for helper scripts that have not been installed yet, which is expected in a dry run.
    out=$(systemd-analyze verify "$f" 2>&1 | grep -F "$SRC/" || true)
    if [ -z "$out" ]; then
        printf '  %-30s ok\n' "$name"
    else
        printf '  %-30s PROBLEMS\n' "$name"
        echo "$out" | sed 's/^/      /' | head -10
        fail=1
    fi
done

if [ "$APPLY" -eq 0 ]; then
    echo
    echo "DRY RUN. Nothing was changed. Re-run with --apply to install."
    exit 0
fi

if [ "$fail" -ne 0 ]; then
    echo
    echo "SOMETHING FAILED. See the messages marked with !! above."
    echo "Nothing was started. Fix the problem and run this again."
    exit 1
fi

echo
echo "== reloading systemd"
run systemctl daemon-reload

echo
echo "== done. Not starting anything yet."
echo
echo "Next:"
echo "  bash bin/status.sh              # what is running, what is enabled"
echo "  sudo bash bin/60-enable-all.sh     # enable and start them all"
echo
echo "The units are installed but not enabled, so nothing starts at boot"
echo "until you enable it. That is deliberate: enable them one at a"
echo "time at first, so you can watch each one fail."
echo
echo "Retire the old supervisor:"
echo "  sudo bash bin/50-retire.sh"
echo
echo "Permanent firewall ports (replaces startup.service):"
echo "  firewall-cmd --permanent --add-port=80/tcp"
echo "  firewall-cmd --permanent --add-port=443/tcp"
echo "  firewall-cmd --reload"
