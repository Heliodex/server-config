#!/usr/bin/env bash
# bin/20-caddy.sh — install the Caddyfile and the Netlify token.
#
# Run:  bash bin/20-caddy.sh
#
# The Caddyfile needs a token for the Netlify DNS challenge. That token is a credential, so it lives in a root:caddy 0640 file that Caddy reads via {$NETLIFY_API_TOKEN}, and is NOT committed to this repo.
#
# The configuration and the web root live under /var/www, because caddy runs in the httpd_t SELinux domain and may not read files under a user's home. See bin/22-caddy-webroot.sh.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
    echo "must run as root"
    exit 1
}

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

WEBROOT=/var/www
install -d -m 0755 "$WEBROOT"
install -m 0644 "$REPO_DIR/etc/caddy/Caddyfile" "$WEBROOT/Caddyfile"

echo "== installed $WEBROOT/Caddyfile"

# The custom Caddy build has to live somewhere a package update will not overwrite. /usr/bin/caddy is owned by the caddy package on openSUSE, so the custom build goes to /usr/local/bin.
#
# Find it: the version with the netlify DNS module is the one that can serve the 'dns netlify' challenge in the Caddyfile.
#
# The destination is skipped as a source. If /usr/local/bin/caddy is already the custom build, copying it onto itself fails, and the failure is silent unless it is checked.
DEST=/usr/local/bin/caddy
SRC=""
for cand in /home/heliodex/caddy/xcb/caddy /home/heliodex/caddy/caddy /bin/caddy /usr/bin/caddy; do
    [ "$cand" = "$DEST" ] && continue
    if [ -x "$cand" ] && [ ! -L "$cand" ]; then
        if "$cand" version 2>/dev/null | grep -q .; then
            SRC="$cand"
            break
        fi
    fi
done

if [ -z "$SRC" ] && [ -x "$DEST" ] && [ ! -L "$DEST" ] && "$DEST" version 2>/dev/null | grep -q .; then
    echo "== $DEST is already a caddy binary, using it in place"
    SRC=""
elif [ -z "$SRC" ]; then
    echo "!! no caddy binary found to install" >&2
    echo "   looked in ~/caddy/xcb/caddy, ~/caddy/caddy, /bin/caddy, /usr/bin/caddy" >&2
    exit 1
else
    echo "== installing $SRC to $DEST"
    install -m 0755 "$SRC" "$DEST"
fi

/usr/local/bin/caddy version 2>&1 | head -1

# The binary must be executable by init_t, and must land in the httpd_t domain so it can read the web root. A file copied out of $HOME can end up with the wrong label, so check and fix it.
echo
echo "== label check"
LABEL=$(ls -Z /usr/local/bin/caddy 2>/dev/null | awk '{print $2}')
echo "  $DEST is $LABEL"
if [ "$LABEL" != "httpd_exec_t" ]; then
    echo "  labelling it httpd_exec_t, which gives the init_t -> httpd_t transition"
    if command -v semanage >/dev/null 2>&1; then
        semanage fcontext -a -t httpd_exec_t "$DEST" 2>&1 | sed 's/^/    /' || true
        restorecon -v "$DEST" 2>&1 | sed 's/^/    /' || true
    else
        echo "    (semanage not installed; falling back to chcon)"
        chcon -t httpd_exec_t "$DEST" 2>&1 | sed 's/^/    /' || true
    fi
    echo "  now: $(ls -Z /usr/local/bin/caddy 2>/dev/null | awk '{print $2}')"
fi

# The token. If the old Caddyfile still has one, lift it out of there.
TOKEN_FILE=/etc/caddy/netlify.token
ENV_FILE=/etc/caddy/netlify.env

install -d -m 0755 /etc/caddy

if [ ! -f "$TOKEN_FILE" ]; then
    old=$(grep -hoE 'nfp_[A-Za-z0-9]+' "$WEBROOT/Caddyfile" /home/heliodex/Caddyfile 2>/dev/null | head -1)
    if [ -n "$old" ]; then
        echo "== lifting the token out of the Caddyfile"
        printf '%s' "$old" >"$TOKEN_FILE"
    else
        echo "== no token found; create $TOKEN_FILE manually"
        : >"$TOKEN_FILE"
    fi
fi

chown root:caddy "$TOKEN_FILE"
chmod 0640 "$TOKEN_FILE"

printf 'NETLIFY_API_TOKEN=%s\n' "$(cat "$TOKEN_FILE")" >"$ENV_FILE"
chown root:caddy "$ENV_FILE"
chmod 0640 "$ENV_FILE"

echo "== wrote $TOKEN_FILE and $ENV_FILE (root:caddy 0640)"

# The old file may still contain the token in plaintext.
if grep -q 'nfp_' /home/heliodex/Caddyfile 2>/dev/null; then
    echo
    echo "!! /home/heliodex/Caddyfile still contains a plaintext token."
    echo "   Redact it once the new config is verified:"
    echo "     sed -i 's/nfp_[A-Za-z0-9]*/REDACTED/' /home/heliodex/Caddyfile"
fi

cat <<'EOF'

== the unit needs these paths =

  [Service]
  ExecStart=/usr/local/bin/caddy run --environ --config /var/www/Caddyfile
  ExecReload=/usr/local/bin/caddy reload --config /var/www/Caddyfile --force
  EnvironmentFile=/etc/caddy/netlify.env
  ReadOnlyPaths=/var/www

== then:

  sudo bash bin/30-install.sh --apply
  systemctl start caddy.service && journalctl -u caddy -f
EOF
