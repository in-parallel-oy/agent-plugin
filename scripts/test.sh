#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node --test scripts/*.test.cjs
