#!/usr/bin/env bash
# Regenerate flat vectors into test/test-vectors (default), then run Foundry tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/scripts"
uv run generate_vectors.py "$@"
cd "$ROOT"
forge test
