# herder-agent

Centralized, **agent-agnostic** setup for running an AI technical department on
the [Herdr](https://github.com/) pane/message protocol — the role system-prompts
("profiles") plus the helper scripts and hook templates that wire them into any
runtime (**pi** as the primary co-worker runtime, Codex, Claude Code).

One source of truth. Clone it on any machine, point your runtimes at it, and a
director agent runs a room of independent co-workers.

## Layout

```
herder-agent/
├── profiles/                       # role system-prompts (the profiles)
│   ├── root_instruction.md         #   director / orchestrator — the ONLY Herdr-aware profile
│   ├── implementer_instruction.md  #   owns one edit scope
│   ├── peer_instruction.md         #   independent perspective / critique
│   ├── reviewer_instruction.md     #   correctness / maintainability / risk review
│   ├── scout_instruction.md        #   codebase survey → wayfinding artifact
│   └── proof_auditor_instruction.md#   verifies evidence proves the claim
├── bin/
│   └── herdr-agent                 # authored helper: spawn a pi co-worker + send a brief
├── hooks/                          # reference templates (Herdr-managed on the live machine)
│   ├── codex-hooks.example.json
│   ├── herdr-agent-state.codex.sh
│   └── herdr-agent-state.claude.sh
├── docs/
│   └── giao-an-herdr.md            # the source philosophy, transcribed to text (reference only)
└── README.md
```

## The one rule

**Only the director loads `profiles/root_instruction.md`.** Co-workers receive
only their own role file and never learn that Herdr exists — an implementer
should feel the task came straight from the user. `root_instruction.md` carries
the full protocol and the operating philosophy; the other files are deliberately
Herdr-free.

| Profile | Knows Herdr? | Edits code? |
| --- | --- | --- |
| `root_instruction.md` | **yes (only one)** | rarely — delegates |
| `implementer_instruction.md` | no | yes, in its scope |
| `peer_instruction.md` | no | no (read-only) |
| `reviewer_instruction.md` | no | no (read-only) |
| `scout_instruction.md` | no | no |
| `proof_auditor_instruction.md` | no | no |

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

4. **Link the attention broker.** Without it a Root receives no completion wakes
   and must not dispatch co-workers.

   ```bash
   herdr plugin link ~/herder-agent/herdr-plugins/attention-broker
   herdr plugin list            # expect: local.attention-broker ... enabled
   ```

   The link points at the repo, so `git pull` updates the plugin in place. It
   needs `node` on PATH. Plugins are global to the user (Herdr 0.7.5+), not
   per-session. Verify the logic without touching a live room:
   `cd ~/herder-agent/herdr-plugins/attention-broker && ./test-wake-path.sh`.

   The broker routes to a seat whose name starts with `root-`, so each Root must
   be named `root-<workspaceId>` — `profiles/root_instruction.md` does that
   rename on entry. A seat still named literally `root` matches nothing and that
   room gets no wakes at all.

5. **Point each runtime at the profiles** — see *Wiring per runtime* below.

That's it. Paths inside the profiles use `~/herder-agent/profiles/…`, which
resolves per-user on any machine (no absolute `/home/<name>` baked in).

## Wiring per runtime

### pi (primary co-worker runtime)

Use the `bin/herdr-agent` helper — `--role <name>` injects that role's profile as
the pi system prompt and resolves the model, provider, and thinking tier from the
role, so a caller normally picks only a role:

```bash
PANE=$(herdr-agent spawn review-auth --role reviewer)
herdr-agent task "$PANE" "<brief>"
```

Defaults, overridable with `--model` / `--provider` / `--thinking`:

| Role | Model | Provider | Thinking |
| --- | --- | --- | --- |
| `peer`, `reviewer`, `proof_auditor` | `glm-5.2` | `zai-coding-cn` | high |
| `implementer`, `scout`, or no role | `deepseek-v4-flash` | `opencode-go` | max |

Under the hood that resolves `${HERDER_AGENT_HOME:-$HOME/herder-agent}/profiles/<role>_instruction.md`
and launches pi with `--append-system-prompt "$(cat <file>)"`. The equivalent
raw invocation for the `reviewer` row:

```bash
pi --provider zai-coding-cn --model glm-5.2 --thinking high --minimal-tui \
   --append-system-prompt "$(cat ~/herder-agent/profiles/reviewer_instruction.md)" \
   -p "<brief>"
```

`--role root` is **refused**: root is the only Herdr-aware profile, and a
co-worker holding it would learn the protocol and could open seats of its own.

### Codex

Point a Codex profile's instructions at the file, or inject at launch if the CLI
exposes a system-prompt flag. The Herdr telemetry hook is wired via
`~/.codex/hooks.json` (see `hooks/codex-hooks.example.json`).

### Claude Code

Reference the root instruction from context — e.g. an `@` import in a
`CLAUDE.md`/`CLAUDE.local.md` so Claude acts as director:

```
@~/herder-agent/profiles/root_instruction.md
```

Claude is the director only. Co-workers run pi (see the table above) — the
expensive model stays with root, and `herdr-agent spawn` is the only path that
opens a seat.

## Design notes

- Instructions are **text** — lossless, diffable, cacheable. Do not convert them
  to images.
- Keep the profile set small. Add a new role only when a behavior repeats and
  re-writing its instruction each time is clearly wasteful.
- The full philosophy behind these files: [*Giáo Án Herdr — First edition*](docs/giao-an-herdr.md)
  (Vietnamese) — a reference doc, not a profile. Co-workers never read it; consult
  it only when designing or tuning `root_instruction.md` and the roles.
