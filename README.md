# herder-agent

Centralized, **agent-agnostic** setup for running an AI technical department on
the [Herdr](https://github.com/) pane/message protocol — the role system-prompts
("profiles") plus the helper scripts and hook templates that wire them into any
runtime (**pi** as the primary co-worker runtime, Codex, Claude Code).

One source of truth. Clone it on any machine, point your runtimes at it, and a
Lead agent runs a room of independent co-workers.

## The room

Three roles, three levels:

- **Lead** (`lead_instruction.md`) — the director. Owns framing, routing,
  ownership, integration, verification, and acceptance. The only role that
  spawns Peers — and, during an ordered handoff, its own successor Lead.
- **Peer** (`peer_instruction.md`) — a plain engineer working "directly with
  the user". Deliberately knows nothing about Herdr, roles, or orchestration;
  it believes it is collaborating with a human. The professional disposition
  (Engineer, Architect, Reviewer, Scout, Proof Auditor) travels in the brief.
- **Supervisor** (`supervisor_instruction.md`) — a governance advisor watching
  the room from above on the Human's behalf. Opened **manually by the Human**;
  never spawned. Speaks to the Lead with evidence-backed observations and
  recommendations, never takes project ownership. Can direct an ordered Lead
  succession (summarize → spawn successor → confirm → close).

| Profile | Knows Herdr? | Opened by | Edits code? |
| --- | --- | --- | --- |
| `lead_instruction.md` | **yes** | Human, or predecessor Lead (succession) | rarely — delegates |
| `peer_instruction.md` | no — believes it talks to a human | Lead | per disposition; Engineer writes |
| `supervisor_instruction.md` | yes | Human, manually | no |

## Layout

```
herder-agent/
├── profiles/                       # role system-prompts (the profiles)
│   ├── lead_instruction.md         #   director / orchestrator
│   ├── peer_instruction.md         #   plain engineer — Herdr-free
│   └── supervisor_instruction.md   #   governance observer
├── bin/
│   └── herdr-agent                 # authored helper: spawn a pi seat + send a brief
├── hooks/                          # reference templates (Herdr-managed on the live machine)
│   ├── codex-hooks.example.json
│   ├── herdr-agent-state.codex.sh
│   └── herdr-agent-state.claude.sh
├── herdr-plugins/
│   └── attention-broker/           # wakes the Lead when a seat needs attention
├── docs/
│   ├── giao-an-herdr.md            # the source philosophy (reference only)
│   └── plan-room-integrity.md
└── README.md
```

## Bootstrap on a new machine

```bash
git clone <this-repo> ~/herder-agent
```

Then have an agent (or you) do the following:

1. **Install Herdr** and confirm the binary is on PATH (`herdr --version`). Herdr
   installs its own per-runtime telemetry hooks (`herdr-agent-state.*.sh`) into
   `~/.codex/` and `~/.claude/hooks/` — those are **Herdr-managed** and get
   regenerated on integration reinstall, so do **not** symlink the copies in
   `hooks/`; they are kept here only as reference. The examples in `hooks/`
   show the expected shape after Herdr installs them.

2. **Symlink the authored helper** onto PATH (ensure `~/.local/bin` is on PATH):

   ```bash
   mkdir -p ~/.local/bin
   ln -sf ~/herder-agent/bin/herdr-agent ~/.local/bin/herdr-agent
   ```

3. **Install the Herdr config.** `herdr-config.toml` in this repo is the authored
   config — `ctrl+space` prefix, and the sidebar rows that make a room readable
   (`$role`, `$name`, `$model`, `$effort` come from pane metadata).

   ```bash
   cp ~/herder-agent/herdr-config.toml ~/.config/herdr/config.toml
   herdr config check           # expect: config: ok
   herdr server reload-config   # expect: "status":"applied"
   ```

   **Copy it, do not symlink it.** Herdr writes to `config.toml` itself (the
   onboarding flag, for one), so a symlink turns every launch into a dirty
   working tree. The cost is that a `git pull` touching `herdr-config.toml`
   needs the copy re-run. A running server does **not** pick up the file on its
   own — without `reload-config` the new rows silently never appear, which looks
   exactly like a Herdr build that lacks the feature.

4. **Link the attention broker.** Without it a Lead receives no completion wakes
   and must not dispatch Peers.

   ```bash
   herdr plugin link ~/herder-agent/herdr-plugins/attention-broker
   herdr plugin list            # expect: local.attention-broker ... enabled
   ```

   The link points at the repo, so `git pull` updates the plugin in place. It
   needs `node` on PATH. Plugins are global to the user (Herdr 0.7.5+), not
   per-session. Verify the logic without touching a live room:
   `cd ~/herder-agent/herdr-plugins/attention-broker && ./test-wake-path.sh`.

   The broker routes to a seat whose name starts with `lead-` (configured as
   `root_prefix` in the plugin's `config.json`), so each Lead must be named
   `lead-<workspaceId>` — `profiles/lead_instruction.md` does that rename on
   entry. A seat still named literally `lead` matches nothing and that room
   gets no wakes at all.

5. **Point each runtime at the profiles** — see *Wiring per runtime* below.

That's it. Paths inside the profiles use `~/herder-agent/profiles/…`, which
resolves per-user on any machine (no absolute `/home/<name>` baked in).

## Wiring per runtime

### pi (primary co-worker runtime)

Use the `bin/herdr-agent` helper — `--role <name>` injects that role's profile as
the pi system prompt and resolves the model, provider, and thinking tier from
the role. Only two roles are spawnable:

```bash
PANE=$(herdr-agent spawn review-auth --role peer)
herdr-agent task "$PANE" "<brief>"       # the brief names the disposition (Reviewer, …)
```

Defaults, overridable with `--model` / `--provider` / `--thinking`:

| Role | Model | Provider | Thinking |
| --- | --- | --- | --- |
| `peer`, or no role | `deepseek-v4-flash` | `opencode-go` | max |
| `lead` | `glm-5.3` | `zai` | high |

The Lead escalates a Peer per task with `--model glm-5.3` (deep critique,
architecture review) instead of hand-tuning thinking. `--role supervisor` is
**refused**: the Supervisor is opened manually by the Human and never spawned.
`--role lead` exists for ordered succession: an old Lead (or the Supervisor on
the Human's behalf) spawns its successor, briefs it with the handoff summary,
confirms it is live, then closes itself — a room is never left without a Lead.

Under the hood the helper resolves
`${HERDER_AGENT_HOME:-$HOME/herder-agent}/profiles/<role>_instruction.md`
and launches pi with `--append-system-prompt "$(cat <file>)"`. The equivalent
raw invocation for the `peer` default:

```bash
pi --provider opencode-go --model deepseek-v4-flash --thinking max --minimal-tui \
   --append-system-prompt "$(cat ~/herder-agent/profiles/peer_instruction.md)" \
   -p "<brief>"
```

### Codex

Point a Codex profile's instructions at the file, or inject at launch if the CLI
exposes a system-prompt flag. The Herdr telemetry hook is wired via
`~/.codex/hooks.json` (see `hooks/codex-hooks.example.json`).

### Claude Code

Reference the lead instruction from context — e.g. an `@` import in a
`CLAUDE.md`/`CLAUDE.local.md` so Claude acts as director:

```
@~/herder-agent/profiles/lead_instruction.md
```

Claude is the Lead only. Co-workers run pi (see the table above) — the
expensive model stays with the Lead, and `herdr-agent spawn` is the only path
that opens a seat.

## Design notes

- Instructions are **text** — lossless, diffable, cacheable. Do not convert them
  to images.
- Keep the profile set small. One Peer profile; the professional disposition
  travels in the brief. Add a new profile only when a behavior repeats and
  re-writing its instruction each time is clearly wasteful.
- The full philosophy behind these files: [*Giáo Án Herdr — First edition*](docs/giao-an-herdr.md)
  (Vietnamese) — a reference doc, not a profile. Peers never read it; consult
  it only when designing or tuning `lead_instruction.md` and the roles.
