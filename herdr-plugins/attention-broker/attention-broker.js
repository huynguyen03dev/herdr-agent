#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const mode = process.argv[2] ?? "event";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const socketPath = process.env.HERDR_SOCKET_PATH;

if (!stateDir || !configDir || !socketPath) {
  fail("Attention Broker must run through Herdr's plugin runtime.");
}

fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

const sessionKey = crypto.createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
const sessionStateDir = path.join(stateDir, "sessions", sessionKey);
fs.mkdirSync(sessionStateDir, { recursive: true });
const statePath = path.join(sessionStateDir, "state.json");
const lockPath = path.join(sessionStateDir, "state.lock");
const config = readJson(path.join(configDir, "config.json"), {});
// Root matching: herdr enforces globally-unique agent names, so a literal
// "root" can only exist once across all workspaces. To run one root per
// workspace, each root is named `root-<workspaceId>` (see
// profiles/root_instruction.md) and the broker identifies live agent roots by
// prefix plus the event's workspace_id. Requiring a runtime and meaningful
// lifecycle prevents a stale pane from hijacking wake delivery.
// `root_name` remains as an optional exact-match override for single-room setups
// that still use a bare name.
const rootNameExact = stringValue(config.root_name);
const rootPrefix = stringValue(config.root_prefix) ?? "root-";
// How long per-seat bookkeeping survives after its terminal disappears from
// `herdr agent list`. Duplicate suppression is keyed on state_change_seq, not
// on a time window, so this is a garbage-collection TTL — not a dedupe window.
// `dedupe_window_ms` is accepted for backward compatibility only.
const stateTtlMs =
  positiveInteger(config.state_ttl_ms) ??
  Math.max((positiveInteger(config.dedupe_window_ms) ?? 5000) * 12, 60000);

if (mode === "status") {
  process.stdout.write(`${JSON.stringify({ session_key: sessionKey, ...readState() }, null, 2)}\n`);
  process.exit(0);
}

if (mode !== "event") {
  fail(`Unknown mode: ${mode}`);
}

const event = parseEnvJson("HERDR_PLUGIN_EVENT_JSON");
const context = parseEnvJson("HERDR_PLUGIN_CONTEXT_JSON", {});
if (!event || !event.event || !event.data) {
  fail("HERDR_PLUGIN_EVENT_JSON did not contain a Herdr event envelope.");
}
const eventName =
  stringValue(process.env.HERDR_PLUGIN_EVENT) ?? normalizeEventName(event.event);

const agents = listAgents();
const workspaceId = event.data.workspace_id ?? context.workspace_id;
const eventPaneId = event.data.pane_id ?? context.focused_pane_id;
const roots = agents.filter(
  (agent) =>
    isRootName(agent.name) &&
    Boolean(stringValue(agent.agent)) &&
    isMeaningfulStatus(agent.agent_status) &&
    (!workspaceId || agent.workspace_id === workspaceId),
);

if (roots.length !== 1) {
  note(
    `ignored ${event.event}: expected one root in workspace ${workspaceId ?? "any"}, ` +
      `found ${roots.length} (${rootMatchLabel()})`,
  );
  process.exit(0);
}

const root = roots[0];
const subject = agents.find((agent) => agent.pane_id === eventPaneId);
const subjectAgent =
  stringValue(event.data.agent) ??
  stringValue(subject?.agent) ??
  stringValue(context.focused_pane_agent);
const subjectName = stringValue(subject?.name);
const status = stringValue(event.data.agent_status) ?? stringValue(subject?.agent_status);
const rootEvent = eventPaneId === root.pane_id;
// Herdr's monotonic per-pane transition counter. This is the identity of a
// state change, so it — not a time window — decides whether we already woke
// the root for this transition. Absent for a pane that has left `agent list`
// (a closed seat), in which case suppression falls back to status comparison.
const subjectSeq = Number.isInteger(subject?.state_change_seq)
  ? subject.state_change_seq
  : null;

note(
  `received ${eventName} pane=${eventPaneId ?? "unknown"} status=${status ?? "none"} ` +
    `subject=${subjectName ?? subjectAgent ?? "unknown"} root=${root.name ?? root.pane_id}`,
);

withStateLock(() => {
  const state = readState();
  const now = Date.now();
  pruneState(state, now);

  // Identify the seat by terminal_id, not pane_id: herdr compacts and reuses
  // pane IDs within minutes, so pane-keyed bookkeeping lets a new seat inherit
  // the suppression state of a dead one. A pane that has already left
  // `agent list` (closed/exited) no longer reports its terminal, so remember
  // the mapping while the seat is alive.
  const seatTerminal =
    stringValue(subject?.terminal_id) ??
    (eventPaneId ? stringValue(state.paneTerminal[eventPaneId]?.terminal_id) : null);
  const seatKey = seatTerminal ?? eventPaneId ?? "unknown-seat";
  if (seatTerminal && eventPaneId) {
    state.paneTerminal[eventPaneId] = {
      terminal_id: seatTerminal,
      // Remembered for the same reason: a crashed seat is gone from
      // `agent list`, so without this the wake would report the bare agent
      // ("pi:exited") and the root would have to hunt for which seat died.
      name: subjectName ?? state.paneTerminal[eventPaneId]?.name ?? null,
      at: now,
    };
  }
  const seatLabel =
    subjectName ?? (eventPaneId ? stringValue(state.paneTerminal[eventPaneId]?.name) : null);

  // Track the most recent *meaningful* status for this seat so a real
  // transition (working->idle) is distinguishable from spawn-time idle->idle
  // noise. `unknown` must never be recorded: the room emits it constantly
  // (herdr reports a pane before it has identified the agent), and letting it
  // overwrite `working` turns a completion into working->unknown->idle, which
  // the transition check below would miss entirely.
  const prevStatus = state.lastStatus[seatKey]?.status ?? null;
  if (subjectAgent && isMeaningfulStatus(status)) {
    state.lastStatus[seatKey] = { status, at: now };
  }

  if (rootEvent) {
    if (status === "idle" || status === "done") {
      flushRoot(state, root, now);
    }
    writeState(state);
    return;
  }

  // A working->idle transition is a completion signal for agents: herdr's poll
  // can miss the transient `done` state and only observe the final `idle`
  // (input prompt). Treat it as a wake, but only when the previous observed
  // status was `working` — that distinguishes a real completion from
  // spawn-time idle->idle noise.
  const workingToIdle =
    eventName === "pane.agent_status_changed" &&
    status === "idle" &&
    prevStatus === "working" &&
    Boolean(subjectAgent);

  // A real `pane.closed` carries no `agent` field and its pane is already gone
  // from `agent list`, so subjectAgent is null exactly when the crash backstop
  // matters most. Having remembered this pane as a seat is the evidence that it
  // was one — and it still excludes plain shell panes from waking the root.
  const knownSeat = Boolean(state.paneTerminal[eventPaneId]);

  if (!shouldQueue(eventName, status, subjectAgent, knownSeat) && !workingToIdle) {
    writeState(state);
    return;
  }

  const notifiedEntry = state.lastNotified[seatKey] ?? null;
  if (notifiedEntry && alreadyNotified(notifiedEntry, subjectSeq, status, prevStatus)) {
    note(
      `suppressed duplicate ${seatLabel ?? subjectAgent ?? seatKey}:` +
        ` status=${status} prev=${prevStatus} seq=${subjectSeq ?? "none"}` +
        ` notified_seq=${notifiedEntry.seq ?? "none"}`,
    );
    writeState(state);
    return;
  }

  // For a working->idle completion (herdr missed the transient `done`),
  // report it as `done` so the root sees a clear completion signal.
  const reportStatus = workingToIdle ? "done" : status ?? terminalReason(eventName);

  state.pending[root.terminal_id] ??= [];
  // An undelivered wake stays queued and stays un-suppressed, so a re-emit of
  // the same transition reaches here again. Don't let the retry stack the same
  // seat twice in one wake line.
  const queued = state.pending[root.terminal_id].some(
    (item) =>
      item?.seat_key === seatKey &&
      item?.status === reportStatus &&
      (item?.seq ?? null) === subjectSeq,
  );
  if (queued) {
    note(`already queued ${seatLabel ?? seatKey}:${reportStatus}; retrying delivery only`);
    flushRoot(state, root, now);
    writeState(state);
    return;
  }
  state.pending[root.terminal_id].push({
    seat_key: seatKey,
    seq: subjectSeq,
    event: eventName,
    workspace_id: workspaceId,
    pane_id: eventPaneId,
    agent: subjectAgent,
    name: seatLabel,
    status: reportStatus,
    observed_at: new Date(now).toISOString(),
  });

  // Suppression is recorded by flushRoot, and only for events it actually
  // delivered. Recording it here instead would burn the wake on a failed
  // delivery: the seat sits at `done` with no further transitions to come, so
  // nothing would ever re-trigger it.
  flushRoot(state, root, now);
  writeState(state);
});

function shouldQueue(eventName, agentStatus, agentLabel, knownSeat) {
  if (eventName === "pane.agent_status_changed") {
    // Wake only on real supervision signals. `idle` is excluded: a freshly
    // spawned co-worker sits idle before it ever gets a task, so waking on it
    // is spawn noise, not a completion.
    return Boolean(agentLabel) && ["done", "blocked"].includes(agentStatus);
  }
  // A seat that died without ever reaching done/blocked is reported only here,
  // and by then it has no agent left to name it — `knownSeat` stands in.
  return (
    (Boolean(agentLabel) || Boolean(knownSeat)) &&
    ["pane.exited", "pane.closed"].includes(eventName)
  );
}

// True when this seat has not left the state we last woke the root for.
//
// state_change_seq is the primary test: it names the exact transition, so a
// re-emit of the same status carries the same seq and is suppressed, while a
// genuine new completion always carries a higher one. A closed pane no longer
// appears in `agent list` and therefore has no seq — for those, an already
// notified seat means this event is cleanup after the wake we already sent.
function alreadyNotified(entry, seq, status, prevStatus) {
  if (Number.isInteger(seq) && Number.isInteger(entry.seq)) return seq <= entry.seq;
  if (status === "closed" || status === "exited" || !status) return true;
  return entry.status === status && prevStatus === status;
}

function isMeaningfulStatus(status) {
  return ["idle", "working", "done", "blocked"].includes(status);
}

function flushRoot(state, root, now) {
  const pending = state.pending[root.terminal_id] ?? [];
  if (pending.length === 0) return;

  const summary = pending
    .map((item) => {
      const seat = item.name ?? item.agent ?? item.pane_id ?? "unknown-seat";
      return `${seat}:${item.status}`;
    })
    .join(", ");
  const prompt =
    `HERDR_ATTENTION_EVENT ${summary}. ` +
    "Consume the current handback or lifecycle gate once. Do not launch a polling loop; " +
    "re-arm attention only after making the next supervision decision.";
  const result = runHerdr(["pane", "run", root.pane_id, prompt]);
  if (result.status !== 0) {
    note(`wake failed for ${root.name ?? root.pane_id}: ${result.stderr.trim()}`);
    return;
  }
  delete state.pending[root.terminal_id];
  // Only a delivered event counts as notified, so a failed wake stays eligible.
  for (const item of pending) {
    if (!item?.seat_key) continue;
    state.lastNotified[item.seat_key] = {
      seq: Number.isInteger(item.seq) ? item.seq : null,
      status: item.status ?? null,
      at: now,
    };
  }
  note(`woke ${root.name ?? root.pane_id} for ${pending.length} event(s)`);
}

function listAgents() {
  const result = runHerdr(["agent", "list"]);
  if (result.status !== 0) {
    fail(`herdr agent list failed: ${result.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    fail(`herdr agent list returned invalid JSON: ${error.message}`);
  }
  return parsed?.result?.agents ?? [];
}

function runHerdr(args) {
  return spawnSync(herdr, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readState() {
  const state = readJson(statePath, {});
  return {
    // root terminal_id -> queued events awaiting delivery.
    pending: objectValue(state.pending),
    // seat terminal_id -> { seq, status, at }: the transition we last woke the
    // root for. Suppression compares against `seq`.
    lastNotified: objectValue(state.lastNotified),
    // seat terminal_id -> { status, at }: most recent meaningful status, used
    // to detect a working->idle completion. Never holds `unknown`.
    lastStatus: migrateLastStatus(objectValue(state.lastStatus)),
    // pane_id -> { terminal_id, at }: lets a closed pane still resolve to the
    // seat identity it had while alive.
    paneTerminal: objectValue(state.paneTerminal),
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Pre-0.2 state stored `lastStatus` as pane_id -> "status" strings, keyed on a
// reusable pane ID. Normalize the shape and stamp it as immediately expirable
// so the pruner clears the stale pane-keyed entries.
function migrateLastStatus(lastStatus) {
  for (const [key, entry] of Object.entries(lastStatus)) {
    if (typeof entry === "string") lastStatus[key] = { status: entry, at: 0 };
  }
  return lastStatus;
}

function writeState(state) {
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, statePath);
}

function withStateLock(callback) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = lockAgeMs();
      if (age !== null && age > 30000) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) fail("timed out acquiring the plugin state lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function lockAgeMs() {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

// Drop bookkeeping for seats that no longer exist. Liveness comes from
// `agent list`, not from age alone: a seat can sit at `done` for hours and
// still re-emit that status, and expiring its entry on a timer would turn the
// next re-emit into a second wake for a completion the root already consumed.
function pruneState(state, now) {
  const liveTerminals = new Set(agents.map((agent) => agent.terminal_id).filter(Boolean));
  const livePanes = new Set(agents.map((agent) => agent.pane_id).filter(Boolean));
  const stale = (key, entry) =>
    !liveTerminals.has(key) &&
    !livePanes.has(key) &&
    (!entry || !Number.isFinite(entry.at) || now - entry.at > stateTtlMs);

  for (const map of [state.lastNotified, state.lastStatus]) {
    for (const [key, entry] of Object.entries(map)) {
      if (stale(key, entry)) delete map[key];
    }
  }
  for (const [paneId, entry] of Object.entries(state.paneTerminal)) {
    if (stale(paneId, entry)) delete state.paneTerminal[paneId];
  }
}

function parseEnvJson(name, fallback = null) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${name} contained invalid JSON: ${error.message}`);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    fail(`could not read ${file}: ${error.message}`);
  }
}

function terminalReason(eventName) {
  return eventName === "pane.closed" ? "closed" : "exited";
}

function normalizeEventName(value) {
  const known = {
    pane_agent_status_changed: "pane.agent_status_changed",
    pane_exited: "pane.exited",
    pane_closed: "pane.closed",
  };
  return known[value] ?? value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A seat is a root when its name matches the configured scheme: either the
// legacy exact `root_name`, or any name beginning with `root_prefix`
// (e.g. "root-w2", "root-w5"). The workspace_id filter in the caller narrows
// which of these roots owns the event; the name only identifies root-ness.
function isRootName(name) {
  if (rootNameExact) return name === rootNameExact;
  return Boolean(name) && name.startsWith(rootPrefix);
}

function rootMatchLabel() {
  return rootNameExact ? `root_name=${rootNameExact}` : `prefix=${rootPrefix}*`;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function note(message) {
  process.stdout.write(`[attention-broker] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[attention-broker] ${message}\n`);
  process.exit(1);
}
