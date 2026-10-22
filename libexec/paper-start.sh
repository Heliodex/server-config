#!/usr/bin/env bash
# libexec/paper-start.sh — start a PaperMC server.
#
# Used as ExecStart= by paper@.service. Finds the paper-*.jar in the instance directory rather than pinning a version, so a Paper update does not require editing the unit file.
#
#   paper-start.sh <instance-directory>
set -uo pipefail

DIR="${1:?usage: paper-start.sh <instance-dir>}"
cd "$DIR" || exit 1

# Newest paper-*.jar wins.
JAR=$(ls -1t "$DIR"/paper-*.jar 2>/dev/null | head -1)
if [ -z "$JAR" ]; then
	echo "paper-start: no paper-*.jar in $DIR" >&2
	exit 1
fi

exec /usr/bin/java \
	-Xms2G -Xmx3G \
	-XX:+UseG1GC \
	-XX:+AlwaysPreTouch \
	-jar "$JAR" \
	--nogui
