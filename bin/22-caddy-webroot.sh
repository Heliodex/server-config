#!/usr/bin/env bash
# bin/22-caddy-webroot.sh — move Caddy's configuration and served files out of $HOME, where SELinux will not let httpd_t read them.
#
# Run:  sudo bash bin/22-caddy-webroot.sh
#
# THE PROBLEM
# -----------
# Caddy runs in the httpd_t domain, and SELinux denies it read access to files under a user's home:
#
#   denied { read } for pid=1904 comm="caddy" name="Caddyfile"
#     scontext=system_u:system_r:httpd_t:s0
#     tcontext=unconfined_u:object_r:user_home_t:s0
#
# The Caddyfile also serves static content from three places under $HOME, and imports two more Caddyfiles from there.
#
# THE FIX
# -------
# Move them under /var/www, which is what a web root is supposed to be, and which gets the right SELinux label automatically. This is better than adding a policy exception: the labels stop being a problem because the files are no longer user data.
#
# The served trees are symlinked, so the data has one home and there is no stale duplicate to keep in sync.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
    echo "must run as root"
    exit 1
}

WEBROOT=/var/www
mkdir -p "$WEBROOT"

echo "== what is there now =="
for p in /home/heliodex/Caddyfile \
    "$WEBROOT/Caddyfile" \
    /home/heliodex/radicle-explorer/build \
    /home/mercury/setup \
    /home/mercury/MercuryCore/Site \
    /home/heliodex/minecraft \
    /srv/ssd/_fileserver; do
    printf '  %-46s ' "$p"
    if [ -e "$p" ]; then
        printf 'exists (%s)' "$(du -sh "$p" 2>/dev/null | cut -f1)"
        if [ -L "$p" ]; then printf ' -> %s' "$(readlink "$p")"; fi
        echo
    else
        echo "absent"
    fi
done

echo
echo "== the Caddyfile's paths =="
for f in "$WEBROOT/Caddyfile" /home/heliodex/Caddyfile; do
    [ -f "$f" ] || continue
    echo "  $f"
    grep -nE 'import |root \*' "$f" | sed 's/^/    /'
done

echo
echo "== moving =="

# The main Caddyfile. Copied, because the unit refers to it by absolute path and the original is what is being replaced.
if [ -f /home/heliodex/Caddyfile ] && [ ! -f "$WEBROOT/Caddyfile" ]; then
    cp -a /home/heliodex/Caddyfile "$WEBROOT/Caddyfile"
    chmod 0644 "$WEBROOT/Caddyfile"
    echo "  /home/heliodex/Caddyfile -> $WEBROOT/Caddyfile"
elif [ -f "$WEBROOT/Caddyfile" ]; then
    echo "  $WEBROOT/Caddyfile already exists, leaving it"
else
    echo "  !! no Caddyfile found in either place" >&2
    exit 1
fi

# Static trees. Symlinked, so the files are edited in one place.
link_tree() {
    local src="$1" dst="$2"
    if [ ! -e "$src" ]; then
        echo "  $src absent, skipping"
        return
    fi
    if [ -e "$dst" ] || [ -L "$dst" ]; then
        rm -rf "$dst"
    fi
    ln -s "$src" "$dst"
    echo "  $dst -> $src"
}

link_tree /home/heliodex/radicle-explorer/build "$WEBROOT/radicle-explorer"
link_tree /home/mercury/setup "$WEBROOT/mercury-setup"
link_tree /home/mercury/MercuryCore/Site "$WEBROOT/mercury-site"
link_tree /home/heliodex/minecraft "$WEBROOT/minecraft"
link_tree /srv/ssd/_fileserver "$WEBROOT/fileserver"

echo
echo "== rewriting the Caddyfile's paths =="
# The imports and roots still point at the old locations.
CADDYFILE=$WEBROOT/Caddyfile
if [ -f "$CADDYFILE" ]; then
    sed -i \
        -e "s#/home/mercury/MercuryCore/Site/Caddyfile#$WEBROOT/mercury-site/Caddyfile#g" \
        -e "s#/home/heliodex/minecraft/Caddyfile#$WEBROOT/minecraft/Caddyfile#g" \
        -e "s#/srv/ssd/_fileserver/Caddyfile#$WEBROOT/fileserver/Caddyfile#g" \
        -e "s#root \* /home/mercury/setup#root * $WEBROOT/mercury-setup#g" \
        -e "s#root \* /home/heliodex/radicle-explorer/build#root * $WEBROOT/radicle-explorer#g" \
        "$CADDYFILE"
    echo "  rewrote the imports and roots"
    echo
    echo "--- the paths it now refers to ---"
    grep -nE 'import |root \*' "$CADDYFILE" | sed 's/^/    /'
fi

echo
echo "== the token =="
if grep -q 'nfp_' "$CADDYFILE" 2>/dev/null; then
    echo "  !! the Caddyfile still has a literal Netlify token."
    echo "     replace it with a variable and put the value in the env file:"
    echo "       sed -i 's/dns netlify nfp_[A-Za-z0-9]*/dns netlify {\\\$NETLIFY_API_TOKEN}/' $CADDYFILE"
    echo "       printf 'NETLIFY_API_TOKEN=%s\\n' TOKEN > /etc/caddy/netlify.env"
    echo "       chown root:caddy /etc/caddy/netlify.env && chmod 0640 /etc/caddy/netlify.env"
else
    echo "  the Caddyfile uses {\$NETLIFY_API_TOKEN}, good"
    if [ -f /etc/caddy/netlify.env ]; then
        echo "  /etc/caddy/netlify.env exists (root:caddy $(stat -c '%a' /etc/caddy/netlify.env))"
    else
        echo "  !! /etc/caddy/netlify.env is missing"
        echo "     run bin/20-caddy.sh to create it"
    fi
fi

echo
echo "== labels =="
ls -Zd "$WEBROOT" 2>&1 | sed 's/^/  /'
ls -Zd "$WEBROOT/Caddyfile" 2>&1 | sed 's/^/  /'
echo
echo "  the symlinked trees keep their original labels, since SELinux"
echo "  resolves the link. Run bin/40-selinux.sh to label them."

cat <<'EOF'

== THEN ==

  sudo bash bin/40-selinux.sh
  sudo bash bin/30-install.sh --apply
  systemctl start caddy.service && journalctl -u caddy -f
EOF

echo
echo "=== DONE ==="
