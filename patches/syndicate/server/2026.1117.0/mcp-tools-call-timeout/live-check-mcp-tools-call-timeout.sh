#!/usr/bin/env bash
# Live A/B check for the SYN-813 mcp-tools-call-timeout dist patch.
#
# Run AFTER paperclip.service was restarted with the patched dist: the running
# process holds the dist it loaded at start, so the patch is inert before that.
#
# Patched (expected): the caller's timeoutMs reaches the tool call.
#   probe 1  timeoutMs=300   -> HTTP 504, reasonCode tool_timeout, well under 1s
#   probe 2  no timeoutMs    -> HTTP 200 (default 10s path unchanged)
#   probe 3  timeoutMs=60000 -> HTTP 200
# Unpatched (the bug): probe 1 returns HTTP 200 after ~1.5s — the timeout is
# ignored and every MCP call is cut at the 10s default.
#
# Usage: live-check-mcp-tools-call-timeout.sh
# Env:   PAPERCLIP_MCP_GATEWAY_URL, PAPERCLIP_MCP_GATEWAY_TOKEN (optional; falls
#        back to the newest agent opencode config).
set -uo pipefail

GW="${PAPERCLIP_MCP_GATEWAY_URL:-}"
TOK="${PAPERCLIP_MCP_GATEWAY_TOKEN:-}"
if [ -z "$GW" ] || [ -z "$TOK" ]; then
  cfg="$(ls -t /tmp/paperclip-opencode-config-*/opencode/opencode.json 2>/dev/null | head -1)"
  if [ -z "$cfg" ]; then
    echo "no agent opencode config found — set PAPERCLIP_MCP_GATEWAY_URL/_TOKEN" >&2
    exit 2
  fi
  GW="$(jq -r '.mcp.ragmir.url' "$cfg")"
  TOK="$(jq -r '.mcp.ragmir.headers.Authorization' "$cfg")"
fi

TOOL="mcp.ragmir-rag-knowledge-base-19b1ff9c:ragmir-ask"

probe() {
  label="$1"
  timeout_field="$2"
  body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",${timeout_field}\"params\":{\"name\":\"${TOOL}\",\"arguments\":{\"project\":\"experience-records\",\"query\":\"live timeout probe\",\"topK\":2}}}"
  out="$(mktemp)"
  meta="$(curl -s -o "$out" -w '%{http_code} %{time_total}' -X POST "$GW" \
    -H "Authorization: $TOK" -H 'content-type: application/json' -d "$body")"
  reason="$(jq -r '.error.data.reasonCode // "none"' "$out" 2>/dev/null)"
  echo "probe ${label}: HTTP ${meta% *} elapsed=${meta#* }s reasonCode=${reason}"
  rm -f "$out"
}

probe "1 timeoutMs=300" '"timeoutMs":300,'
probe "2 no timeout" ''
probe "3 timeoutMs=60000" '"timeoutMs":60000,'
