#!/bin/sh
# Clear group and other write on the directory helper before launchd starts
# the app. A umask 002 checkout otherwise leaves every in-place save refused.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
chmod go-w "$root/editor/bin" "$root"/editor/bin/dirfd-tool-*
echo "helper modes set"
