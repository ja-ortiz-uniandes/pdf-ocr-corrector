#!/usr/bin/env bash
# macOS convenience wrapper: Finder can double-click .command files directly
# (a plain .sh usually opens in an editor instead).
cd "$(dirname "$0")"
exec ./start.sh
