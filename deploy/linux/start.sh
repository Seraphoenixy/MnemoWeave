#!/bin/sh
set -eu

bundle_dir=$(CDPATH= cd -- "${0%/*}" && pwd)
exec "$bundle_dir/node" "$bundle_dir/mnemo-weave-sync-server.mjs" "$@"
