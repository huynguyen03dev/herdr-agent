#!/usr/bin/env bash
# Regression cases for the broker's wake path. Runs the real plugin against a
# fake `herdr` and a scratch state dir, so it never touches a live room and
# never injects text into anyone's pane.
#
#   ./test-wake-path.sh
#
# Every case here corresponds to a way the wake path has actually been observed
# to fail. Read the code all you like — the acceptance test is this passing.

set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$(mktemp -d)"
trap 'rm -rf "$HARNESS"' EXIT
export HARNESS
mkdir -p "$HARNESS/state" "$HARNESS/config"

cat > "$HARNESS/herdr" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "agent list") cat "$HARNESS/agents.json" ;;
  "pane run")   shift 2; echo "WAKE-> $2" >> "$HARNESS/wakes.log" ;;
  *)            echo "unexpected herdr call: $*" >&2; exit 9 ;;
esac
SH
chmod +x "$HARNESS/herdr"

reset_room() {
  rm -rf "$HARNESS/state" "$HARNESS/wakes.log"
  mkdir -p "$HARNESS/state"
  cat > "$HARNESS/agents.json" <<'JSON'
{"result":{"agents":[
 {"pane_id":"wT:p1","terminal_id":"term_root","workspace_id":"wT","name":"root-wT","agent":"claude","agent_status":"idle","state_change_seq":100},
 {"pane_id":"wT:pA","terminal_id":"term_a","workspace_id":"wT","name":"seat-a","agent":"pi","agent_status":"idle","state_change_seq":200},
 {"pane_id":"wT:pB","terminal_id":"term_b","workspace_id":"wT","name":"seat-b","agent":"pi","agent_status":"idle","state_change_seq":300},
 {"pane_id":"wT:pS","terminal_id":"term_s","workspace_id":"wT","name":null,"agent":null,"agent_status":"idle","state_change_seq":10}
]}}
JSON
}

# fire <event> <pane> <status|gone> <seq>
#
# `gone` reproduces a real pane.closed/pane.exited: the pane has already left
# `agent list` AND the event carries no `agent` field. Faking an agent here is
# what previously hid a dead crash backstop.
fire() {
  local event="$1" pane="$2" status="$3" seq="$4"
  python3 - "$HARNESS/agents.json" "$pane" "$status" "$seq" <<'PY'
import sys, json
path, pane, status, seq = sys.argv[1:5]
doc = json.load(open(path))
agents = doc["result"]["agents"]
if status == "gone":
    doc["result"]["agents"] = [a for a in agents if a["pane_id"] != pane]
else:
    for a in agents:
        if a["pane_id"] == pane:
            a["agent_status"] = status
            a["state_change_seq"] = int(seq)
json.dump(doc, open(path, "w"))
PY
  if [ "$status" = "gone" ]; then
    export HERDR_PLUGIN_EVENT_JSON="{\"event\":\"$event\",\"data\":{\"workspace_id\":\"wT\",\"pane_id\":\"$pane\"}}"
  else
    export HERDR_PLUGIN_EVENT_JSON="{\"event\":\"$event\",\"data\":{\"workspace_id\":\"wT\",\"pane_id\":\"$pane\",\"agent\":\"pi\",\"agent_status\":\"$status\"}}"
  fi
  HERDR_PLUGIN_STATE_DIR="$HARNESS/state" \
  HERDR_PLUGIN_CONFIG_DIR="$HARNESS/config" \
  HERDR_SOCKET_PATH="/tmp/attention-broker-test.sock" \
  HERDR_BIN_PATH="$HARNESS/herdr" \
  HERDR_PLUGIN_EVENT="$event" \
  HERDR_PLUGIN_CONTEXT_JSON='{"workspace_id":"wT"}' \
    node "$PLUGIN_DIR/attention-broker.js" event >/dev/null 2>&1
}

# `grep -c` prints 0 *and* exits 1 on no match, so a `|| echo 0` fallback would
# emit "0\n0". Count lines instead.
wakes() {
  [ -f "$HARNESS/wakes.log" ] || { echo 0; return; }
  grep -c WAKE "$HARNESS/wakes.log" | head -1
}

FAILED=0
expect() {
  local label="$1" want="$2" got
  got="$(wakes)"
  if [ "$got" = "$want" ]; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s (wakes=%s, expected %s)\n' "$label" "$got" "$want"
    FAILED=1
  fi
}

expect_named() {
  local label="$1" want="$2"
  if grep -q "HERDR_ATTENTION_EVENT $want" "$HARNESS/wakes.log" 2>/dev/null; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s (no wake matching "%s")\n' "$label" "$want"
    FAILED=1
  fi
}

node --check "$PLUGIN_DIR/attention-broker.js" || exit 1
reset_room

# A stale pane can retain a root-prefixed name and agent label after its
# lifecycle becomes unknown. It must not become the broker's delivery target.
python3 - "$HARNESS/agents.json" <<'PY'
import sys, json
path = sys.argv[1]
doc = json.load(open(path))
root = next(a for a in doc["result"]["agents"] if a["pane_id"] == "wT:p1")
root["agent"] = "codex"
root["agent_status"] = "unknown"
json.dump(doc, open(path, "w"))
PY
fire pane.agent_status_changed wT:pA working 191
fire pane.agent_status_changed wT:pA done    192
expect "stale named unknown pane is not a root" 0
reset_room

# A completion whose transient `done` herdr missed, with the room's constant
# `unknown` noise interleaved. Recording `unknown` as the previous status broke
# the working->idle check and silently dropped the wake.
fire pane.agent_status_changed wT:pA working 201
fire pane.agent_status_changed wT:pA unknown 202
fire pane.agent_status_changed wT:pA idle    203
expect "completion survives interleaved unknown" 1
fire pane.agent_status_changed wT:pA idle    203
expect "re-emit at the same state_change_seq is suppressed" 1

# A second task on the same seat must wake again; its re-emit must not.
fire pane.agent_status_changed wT:pA working 210
fire pane.agent_status_changed wT:pA done    211
expect "second task cycle wakes" 2
fire pane.agent_status_changed wT:pA done    211
expect "repeated done is suppressed" 2
fire pane.closed wT:pA gone 211
expect "close after a delivered done is cleanup, not a completion" 2

# A seat that dies mid-task reports no status and vanishes from agent list.
fire pane.agent_status_changed wT:pB working 301
fire pane.closed wT:pB gone 301
expect "crash while working wakes the root" 3
expect_named "crashed seat is named, not reported as bare 'pi'" "seat-b:closed"

# A plain shell pane closing is not a supervision event.
fire pane.closed wT:pS gone 10
expect "closing a non-agent pane stays silent" 3

# herdr reuses pane IDs within minutes; a new seat must not inherit the dead
# seat's suppression, even when its counter starts lower.
python3 - "$HARNESS/agents.json" <<'PY'
import sys, json
path = sys.argv[1]
doc = json.load(open(path))
doc["result"]["agents"].append({
    "pane_id": "wT:pA", "terminal_id": "term_new", "workspace_id": "wT",
    "name": "seat-new", "agent": "pi", "agent_status": "idle",
    "state_change_seq": 5,
})
json.dump(doc, open(path, "w"))
PY
fire pane.agent_status_changed wT:pA working 5
fire pane.agent_status_changed wT:pA done    6
expect "reused pane with a lower counter still wakes" 4
expect_named "reused pane reports the new seat" "seat-new:done"

# A failed delivery must leave the event queued and the seat un-suppressed, so
# the next event re-delivers instead of burning the wake.
reset_room
cat > "$HARNESS/herdr" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "agent list") cat "$HARNESS/agents.json" ;;
  "pane run")   echo "delivery refused" >&2; exit 1 ;;
esac
SH
chmod +x "$HARNESS/herdr"
fire pane.agent_status_changed wT:pA working 401
fire pane.agent_status_changed wT:pA done    402
expect "failed delivery produces no wake" 0
cat > "$HARNESS/herdr" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "agent list") cat "$HARNESS/agents.json" ;;
  "pane run")   shift 2; echo "WAKE-> $2" >> "$HARNESS/wakes.log" ;;
esac
SH
chmod +x "$HARNESS/herdr"
fire pane.agent_status_changed wT:pA done 402
expect "next event re-delivers the queued wake" 1
if grep -q 'seat-a:done, seat-a:done' "$HARNESS/wakes.log" 2>/dev/null; then
  printf 'FAIL  %s\n' "retry stacked a duplicate entry"
  printf '      wake line: %s\n' "$(cat "$HARNESS/wakes.log")"
  FAILED=1
else
  printf 'PASS  %s\n' "retry does not stack a duplicate entry"
fi

# Pre-0.2 state stored lastStatus as pane-keyed strings; loading it must not throw.
reset_room
KEY="$(python3 -c 'import hashlib;print(hashlib.sha256(b"/tmp/attention-broker-test.sock").hexdigest()[:16])')"
mkdir -p "$HARNESS/state/sessions/$KEY"
cat > "$HARNESS/state/sessions/$KEY/state.json" <<'JSON'
{"pending":{},"recent":{"stale:signature":1753500000000},
 "notified":{"wT:pZ":{"status":"done","at":1753500000000}},
 "lastStatus":{"wT:pZ":"unknown","wT:pA":"working"}}
JSON
fire pane.agent_status_changed wT:pA done 205
expect "legacy state file loads and still wakes" 1

echo
[ "$FAILED" = "0" ] && echo "all cases passed" || echo "FAILURES ABOVE"
exit "$FAILED"
