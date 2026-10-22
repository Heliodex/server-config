#!/usr/bin/env bash
# bin/lint-vars.sh — find variables used but never assigned in the same file.
#
# Under `set -u` those are runtime "unbound variable" errors, and they only surface when the script reaches that line. This checks every script without running it.
#
# How it works, in order:
#   1. take the file, drop whole-line comments
#   2. find every $name and ${name} expansion
#   3. drop the ones that are inside a literal string, where $name is
#      just text
#   4. drop the ones that have a default, ${name:-x}, which are safe
#   5. compare against the names the file assigns
#
# It is a rough check and some false positives remain, but it catches the real class of bug.
set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

fail=0

for f in bin/*.sh libexec/*.sh; do
    [ -f "$f" ] || continue

    # Names this file assigns: plain assignments, the second and later names in a multi-assignment, for loop variables, read targets, and names given a default.
    assigned=$(
        {
            grep -oE '(^|[[:space:]])(local[[:space:]]+|export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$f" \
                | sed -E 's/^[[:space:]]*//; s/^(local|export)[[:space:]]+//' \
                | sed -E 's/=.*//'
            grep -oE 'for[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' "$f" | awk '{print $2}'
            # `read -r a b c` assigns every name on the line, not just the first, and it can be at the end of a pipeline:
            #   ... | while read -r f; do
            awk '{
                    line = $0
                    if (!match(line, /read[[:space:]]+/)) next
                    line = substr(line, RSTART + RLENGTH)
                    while (match(line, /^-[a-zA-Z]+[[:space:]]+/))
                        line = substr(line, RLENGTH + 1)
                    sub(/[[:space:]]*<<<.*$/, "", line)
                    sub(/[[:space:]]*<.*$/, "", line)
                    sub(/;.*$/, "", line)
                    sub(/[[:space:]]+do[[:space:]]*$/, "", line)
                    n = split(line, a, /[[:space:]]+/)
                    for (i = 1; i <= n; i++)
                        if (a[i] ~ /^[A-Za-z_][A-Za-z0-9_]*$/) print a[i]
                 }' "$f"
            grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*(:-|:=|:\+)' "$f" \
                | sed -E 's/^\$\{//; s/(:-|:=|:\+)$//'
        } | sort -u
    )

    # Names this file expands, with the ones that are only literal text removed. The expansion has to be found before the literals are stripped, or the stripping eats the variable with them.
    used=$(
        # Strip comments: a # that starts the line, or follows whitespace.
        # A # inside a word is not a comment.
        awk '
            # Skip the body of a heredoc: it is literal text, not code.
            /<<[-]?[\x27\x22]?[A-Z_]+[\x27\x22]?[[:space:]]*$/ { inhere = 1; next }
            inhere && /^(EOF|HEREDOC|END)[[:space:]]*$/ { inhere = 0; next }
            inhere { next }
            {
                line = $0
                sub(/^[[:space:]]*#.*/, "", line)
                gsub(/[[:space:]]#.*/, "", line)
                print line
            }
        ' "$f" \
            | grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*' \
            | sed -E 's/^\$\{?//' | sort -u
    )

    # A name is only a real expansion if it appears outside a quoted span. Single quotes are always literal. Double quotes are literal only when they contain no $ at all, because "$name" inside double quotes still expands.
    literal_free=$(
        awk '
            {
                line = $0
                # single-quoted spans are always literal
                gsub(/'"'"'[^'"'"']*'"'"'/, "", line)
                # double-quoted spans with no $ in them are literal.
                # An escaped dollar (\$) is literal text too, and removing the backslash would turn it into a live expansion, so replace the whole escape with a placeholder instead.
                gsub(/\\\$/, "@ESC@", line)
                while (match(line, /"[^"$]*"/)) {
                    line = substr(line, 1, RSTART - 1) substr(line, RSTART + RLENGTH)
                }
                gsub(/@ESC@/, "", line)
                print line
            }
        ' "$f"
    )

    for u in $used; do
        case "$u" in
            1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | @ | \* | \# | \? | \! | - | BASH_SOURCE | HOME | USER | PATH | PWD | IFS) continue ;;
        esac
        echo "$assigned" | grep -qx "$u" && continue
        # skip if it only ever appears inside quotes
        if ! echo "$literal_free" | grep -qE "\\\$\\{?$u([^A-Za-z0-9_]|\$)"; then
            continue
        fi
        printf '  %-32s $%s used but never assigned\n' "$f" "$u"
        fail=1
    done
done

# A '[' test whose closing ']' is missing is a syntax error that bash -n does NOT catch, because '[' is an ordinary command and the unbalanced bracket is only noticed at run time. Check for it separately.
for f in bin/*.sh libexec/*.sh; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
        case "$line" in
            *']'*) continue ;;
        esac
        # Only lines that start a test command
        case "$line" in
            *'[ '*'-eq'* | *'[ '*'-ne'* | *'[ '*'-lt'* | *'[ '*'-gt'*)
                printf '  %-32s %s\n' "$f" "test with a missing ]: $line"
                fail=1
                ;;
        esac
    done < <(grep -E '^[[:space:]]*\[.*(-eq|-ne|-lt|-gt|-ge|-le)[[:space:]]' "$f")
done

if [ "$fail" -eq 0 ]; then
    echo "no unbound variables found"
fi
exit $fail
