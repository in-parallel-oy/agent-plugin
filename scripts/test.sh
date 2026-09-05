#!/bin/sh
#
# Self-contained check for the three hook scripts.
#
#   sh scripts/test.sh
#
# Runs each script the way a client would — hook JSON on stdin — against a
# throwaway HOME, a throwaway git repository, a stub `gh`, and a real HTTP
# server on 127.0.0.1 standing in for the heartbeat endpoint. Needs node and
# git; touches nothing outside its temp directory.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/in-parallel-plugin-test.XXXXXX")
SERVER_PID=''

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

ok() {
  printf 'ok - %s\n' "$1"
}

HOME="$TMP/home"
export HOME
mkdir -p "$HOME"
CLAIMS="$HOME/.in-parallel/claims.json"
CLAIM_ID='b3f1c0de-0000-4000-8000-000000000001'

# --- fake heartbeat server ---------------------------------------------------

cat > "$TMP/server.js" <<'SERVER'
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const [, , logFile, portFile] = process.argv
const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.method} ${req.url} ${req.headers.authorization || '-'}\n`)
  const status = req.url.startsWith('/beat/gone') ? 409 : req.url.startsWith('/beat/bad') ? 401 : 204
  res.writeHead(status)
  res.end()
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)))
SERVER

: > "$TMP/requests.log"
node "$TMP/server.js" "$TMP/requests.log" "$TMP/port" &
SERVER_PID=$!

tries=0
while [ ! -s "$TMP/port" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then fail 'fake heartbeat server did not start'; fi
  sleep 0.1
done
BEAT_OK="http://127.0.0.1:$(cat "$TMP/port")/beat/ok"
BEAT_GONE="http://127.0.0.1:$(cat "$TMP/port")/beat/gone"

# --- fake repository and stub gh ---------------------------------------------

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GH'
#!/bin/sh
printf '%s\n' '[{"url":"https://github.com/in-parallel-oy/agent-plugin/pull/7"}]'
GH
chmod +x "$TMP/bin/gh"
PATH="$TMP/bin:$PATH"
export PATH

git init -q "$TMP/repo"
git -C "$TMP/repo" symbolic-ref HEAD refs/heads/work-claims-demo
git -C "$TMP/repo" remote add origin git@github.com:in-parallel-oy/agent-plugin.git

# --- helpers -----------------------------------------------------------------

# announce_work reply, wrapped the way an MCP client hands a tool result back:
# a content array whose text part is a JSON *string*.
write_start_payload() {
  node -e '
    const fs = require("node:fs")
    const [file, claimId, beatUrl] = process.argv.slice(1)
    const reply = {
      outcome: "started",
      message: "Work started with no exact related work found.",
      claim: {
        claim_id: claimId,
        workspace_id: "acme",
        description: "Fix the login redirect loop",
        uri: "https://github.com/in-parallel-oy/agent-plugin/pull/7",
        state: "working",
        started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      },
      active_overlaps: [],
      related_work: [],
      recommended_action: "continue",
      heartbeat: { token: "test-token", url: beatUrl, interval_seconds: 300 },
      server_time: new Date().toISOString(),
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_id: "session-1",
        hook_event_name: "PostToolUse",
        cwd: process.cwd(),
        tool_name: "mcp__in-parallel__announce_work",
        tool_input: { action: "start", description: "Fix the login redirect loop" },
        tool_response: { content: [{ type: "text", text: JSON.stringify(reply) }] },
      }),
    )
  ' "$1" "$CLAIM_ID" "$2"
}

claim_field() {
  node -e '
    const fs = require("node:fs")
    const [file, id, field] = process.argv.slice(1)
    const claim = (JSON.parse(fs.readFileSync(file, "utf8")).claims || {})[id]
    const value = field.split(".").reduce((node, key) => (node == null ? node : node[key]), claim)
    process.stdout.write(value == null ? "" : String(value))
  ' "$CLAIMS" "$CLAIM_ID" "$1"
}

age_last_beat() {
  node -e '
    const fs = require("node:fs")
    const [file, id, url] = process.argv.slice(1)
    const store = JSON.parse(fs.readFileSync(file, "utf8"))
    store.claims[id].last_beat_at = "2000-01-01T00:00:00.000Z"
    store.claims[id].heartbeat.url = url
    fs.writeFileSync(file, JSON.stringify(store))
  ' "$CLAIMS" "$CLAIM_ID" "$1"
}

# --- 1. remember-claim stores the claim --------------------------------------

write_start_payload "$TMP/start.json" "$BEAT_OK"
node "$ROOT/scripts/remember-claim.js" < "$TMP/start.json" > "$TMP/out" 2>&1
[ -s "$TMP/out" ] && fail "remember-claim printed output: $(cat "$TMP/out")"
[ -f "$CLAIMS" ] || fail 'remember-claim did not create claims.json'
[ "$(claim_field claim_id)" = "$CLAIM_ID" ] || fail 'claim id not stored'
[ "$(claim_field description)" = 'Fix the login redirect loop' ] || fail 'description not stored'
[ "$(claim_field uri)" = 'https://github.com/in-parallel-oy/agent-plugin/pull/7' ] || fail 'uri not stored'
[ "$(claim_field heartbeat.token)" = 'test-token' ] || fail 'heartbeat token not stored'
[ "$(claim_field heartbeat.interval_seconds)" = '300' ] || fail 'heartbeat interval not stored'
[ -n "$(claim_field started_at)" ] || fail 'started_at not stored'
[ -n "$(claim_field last_beat_at)" ] || fail 'last_beat_at not initialised'
mode=$(node -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$CLAIMS")
[ "$mode" = '600' ] || fail "claims.json mode is $mode, expected 600"
ok 'remember-claim stores a started claim from a string-encoded reply, 0600'

# --- 2. context line ---------------------------------------------------------

printf '%s' '{"session_id":"session-1","hook_event_name":"SessionStart","cwd":"'"$TMP/repo"'"}' \
  | node "$ROOT/scripts/context.js" > "$TMP/context.out"
lines=$(awk 'END { print NR }' "$TMP/context.out")
[ "$lines" = '1' ] || fail "context emitted $lines lines, expected 1"
line=$(cat "$TMP/context.out")
case "$line" in
  '[in-parallel] '*) : ;;
  *) fail "context line does not start with [in-parallel]: $line" ;;
esac
case "$line" in *'repo=https://github.com/in-parallel-oy/agent-plugin'*) : ;; *) fail "no normalized repo url: $line" ;; esac
case "$line" in *'branch=work-claims-demo'*) : ;; *) fail "no branch: $line" ;; esac
case "$line" in *'pr=https://github.com/in-parallel-oy/agent-plugin/pull/7'*) : ;; *) fail "no pull request url: $line" ;; esac
case "$line" in *"$CLAIM_ID"*) : ;; *) fail "no open claim summary: $line" ;; esac
case "$line" in *'started 3h ago'*) : ;; *) fail "no started age: $line" ;; esac
case "$line" in *'heartbeat '*) : ;; *) fail "no heartbeat age: $line" ;; esac
case "$line" in *'announce_work start'*) : ;; *) fail "no reminder: $line" ;; esac
ok 'context emits one [in-parallel] line with repo, branch, pull request, claims and reminder'

# Same session, same branch: silent.
printf '%s' '{"session_id":"session-1","hook_event_name":"UserPromptSubmit","cwd":"'"$TMP/repo"'"}' \
  | node "$ROOT/scripts/context.js" > "$TMP/context2.out"
[ -s "$TMP/context2.out" ] && fail 'context re-emitted within the same session on the same branch'
# Same session, new branch: emitted again.
git -C "$TMP/repo" symbolic-ref HEAD refs/heads/other-branch
printf '%s' '{"session_id":"session-1","hook_event_name":"UserPromptSubmit","cwd":"'"$TMP/repo"'"}' \
  | node "$ROOT/scripts/context.js" > "$TMP/context3.out"
grep -q 'branch=other-branch' "$TMP/context3.out" || fail 'context did not re-emit after a branch change'
ok 'context emits once per session and again when the branch changes'

# Cursor takes context only through the JSON additional_context field.
printf '%s' '{"conversation_id":"cursor-1","hook_event_name":"sessionStart","workspace_roots":["'"$TMP/repo"'"]}' \
  | node "$ROOT/scripts/context.js" > "$TMP/context4.out"
node -e '
  const fs = require("node:fs")
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (!parsed.additional_context.startsWith("[in-parallel] ")) throw new Error("bad additional_context")
' "$TMP/context4.out" || fail 'cursor output is not {"additional_context": "[in-parallel] ..."}'
ok 'context wraps the line in additional_context for Cursor'

# --- 3. heartbeat POSTs and records the beat ---------------------------------

age_last_beat "$BEAT_OK"
node "$ROOT/scripts/heartbeat.js" < /dev/null > "$TMP/beat.out" 2>&1
[ -s "$TMP/beat.out" ] && fail "heartbeat printed output: $(cat "$TMP/beat.out")"
grep -q '^POST /beat/ok Bearer test-token$' "$TMP/requests.log" \
  || fail "heartbeat did not POST with the bearer token: $(cat "$TMP/requests.log")"
beat=$(claim_field last_beat_at)
case "$beat" in
  2000-*) fail 'heartbeat did not update last_beat_at after 204' ;;
  '') fail 'claim disappeared after a 204' ;;
  *) : ;;
esac
ok 'heartbeat POSTs a due claim with the bearer token and records the beat on 204'

# A claim not yet due is left alone.
: > "$TMP/requests.log"
node "$ROOT/scripts/heartbeat.js" < /dev/null
[ -s "$TMP/requests.log" ] && fail 'heartbeat beat a claim that was not due'
ok 'heartbeat skips claims inside their interval'

# --- 4. heartbeat drops a claim the server no longer knows -------------------

age_last_beat "$BEAT_GONE"
node "$ROOT/scripts/heartbeat.js" < /dev/null
[ -z "$(claim_field claim_id)" ] || fail 'claim survived a 409'
ok 'heartbeat removes the claim on 409'

# --- 5. remember-claim removes a completed claim -----------------------------

write_start_payload "$TMP/start2.json" "$BEAT_OK"
node "$ROOT/scripts/remember-claim.js" < "$TMP/start2.json"
[ "$(claim_field claim_id)" = "$CLAIM_ID" ] || fail 'claim not re-stored'
node -e '
  const fs = require("node:fs")
  const [file, claimId] = process.argv.slice(1)
  fs.writeFileSync(
    file,
    JSON.stringify({
      hook_event_name: "afterMCPExecution",
      tool_name: "announce_work",
      mcp_server_name: "in-parallel",
      result_json: {
        structuredContent: {
          outcome: "completed",
          message: "Work was completed.",
          claim: { claim_id: claimId, state: "completed", reason: "Merged" },
        },
      },
    }),
  )
' "$TMP/complete.json" "$CLAIM_ID"
node "$ROOT/scripts/remember-claim.js" < "$TMP/complete.json"
[ -z "$(claim_field claim_id)" ] || fail 'completed claim was not removed'
ok 'remember-claim removes a claim on a completed outcome'

# --- 6. nothing breaks on junk ----------------------------------------------

printf '%s' 'not json' | node "$ROOT/scripts/context.js" > /dev/null
printf '%s' 'not json' | node "$ROOT/scripts/remember-claim.js" > /dev/null
printf '%s' '{"tool_name":"Bash","tool_response":"ok"}' | node "$ROOT/scripts/remember-claim.js" > /dev/null
node "$ROOT/scripts/heartbeat.js" < /dev/null
ok 'scripts exit 0 on malformed or unrelated input'

printf '\nAll checks passed.\n'
