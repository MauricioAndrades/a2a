#!/usr/bin/env bash

set -o pipefail

A2A_BIN="${A2A_BIN:-a2a}"

"$A2A_BIN" status --segment --no-peers 2>/dev/null || true
