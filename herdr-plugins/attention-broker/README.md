# Herdr Attention Broker

Local event-driven prototype for Herdr engineering rooms. It listens for agent
lifecycle events and wakes the room's root seat once when another agent reaches
`done` or `blocked`, completes a `working -> idle` transition, or dies without
reporting either.

The plugin does not poll, run a model, inspect project files, or decide whether a
checkpoint should be accepted. Events are persisted before delivery and submitted
to root with `pane run`; a busy root consumes them at its next message
boundary. Runtime state is namespaced by the named session socket, so linked
rooms cannot deduplicate or deliver one another's events even when their workspace
and pane IDs overlap.

**Delivery.** A `pane run` that exits non-zero leaves the event queued *and*
leaves the seat un-suppressed, so the next event for that seat re-delivers the
whole queue rather than burning the wake. A retry never stacks a duplicate entry
for the same seat and transition. Note the honest limit: exit 0 means the text
reached the pane, not that root processed it — no room-side confirmation exists.

**Duplicate suppression is keyed on `state_change_seq`**, herdr's monotonic
per-pane transition counter, not on a time window. A re-emitted status carries
the same counter and is suppressed; a genuine new completion always carries a
higher one. Bookkeeping is keyed on `terminal_id`, because herdr compacts and
reuses pane IDs within minutes and a pane-keyed entry would let a new seat
inherit a dead seat's suppression. Entries are dropped once their terminal has
left `herdr agent list` and aged out — never on a timer alone, since a seat can
sit at `done` for hours and still re-emit it.

**Crash backstop.** `pane.exited` / `pane.closed` are subscribed because a seat
that crashes or is killed emits no status change. These events carry no `agent`
field and their pane is already gone from `agent list`, so the broker recognizes
the seat from the pane→terminal mapping it recorded while the seat was alive.
That also keeps ordinary shell panes from waking root. A close that follows a
wake we already delivered is cleanup, not a new completion, and stays silent.

## Root naming and multi-workspace support

Herdr enforces globally-unique agent names, so a literal `root` can only exist
once across **all** workspaces. To run one root per workspace (the default
scheme), each root is named `root-<workspaceId>` (e.g. `root-w2`, `root-w5`).
The broker identifies roots by the configurable prefix and routes events to the
root whose `workspace_id` matches the event. `profiles/root_instruction.md`
performs the rename as `herdr agent rename "$HERDR_PANE_ID" "root-${HERDR_WORKSPACE_ID}"`
on entry.

Link it into a named room:

```bash
herdr --session Fantasy plugin link /mnt/d/agent-workflow/herdr-plugins/attention-broker
```

Optional config lives at the directory printed by:

```bash
herdr --session Fantasy plugin config-dir local.attention-broker
```

Example `config.json`:

```json
{
  "root_prefix": "root-",
  "state_ttl_ms": 60000
}
```

Optional `root_name` (string) overrides prefix matching with a single exact
name — use only for single-room setups that still name the seat literally.
Optional `root_prefix` (string, default `root-`) is the prefix a root name must
begin with in the default multi-workspace scheme.
Optional `state_ttl_ms` (integer, default 60000) is how long per-seat
bookkeeping survives after its terminal disappears from `agent list`. It is a
garbage-collection TTL, not a dedupe window — suppression is decided by
`state_change_seq`. The older `dedupe_window_ms` key is still read (as
`× 12`, floor 60s) so existing configs keep working, but it no longer gates any
duplicate check and new configs should use `state_ttl_ms`.

Regression cases for the wake path — every one of them a way it has actually been
observed to fail. Runs the real plugin against a fake `herdr` and a scratch state
dir, so it never touches a live room:

```bash
./test-wake-path.sh
```

Inspect queued events and plugin command results with:

```bash
herdr --session Fantasy plugin action invoke local.attention-broker.status
herdr --session Fantasy plugin log list --plugin local.attention-broker
```

This first slice intentionally has no periodic deadline. It replaces completion
polling; a later slice may add a deterministic reassessment timer if live room
evidence shows it is necessary.
