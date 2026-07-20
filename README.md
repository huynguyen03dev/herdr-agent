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

3. **Point each runtime at the profiles** — see *Wiring per runtime* below.

That's it. Paths inside the profiles use `~/herder-agent/profiles/…`, which
resolves per-user on any machine (no absolute `/home/<name>` baked in).

## Wiring per runtime

### pi (primary co-worker runtime)

Use the `bin/herdr-agent` helper — `--role <name>` injects that role's profile
as the pi system prompt, so callers pick a role and a model, nothing else:

```bash
PANE=$(herdr-agent spawn review-auth --role reviewer --model deepseek-v4-flash)
herdr-agent task "$PANE" "<brief>"
```

Under the hood that resolves `${HERDER_AGENT_HOME:-$HOME/herder-agent}/profiles/<role>_instruction.md`
and launches pi with `--append-system-prompt "$(cat <file>)"`. The equivalent
raw invocation:

```bash
pi --provider opencode-go --model deepseek-v4-flash --thinking max --minimal-tui \
   --append-system-prompt "$(cat ~/herder-agent/profiles/reviewer_instruction.md)" \
   -p "<brief>"
```

`--role` accepts any role except `root` (root is the director, never a
co-worker). Model stays the caller's choice — the helper only handles profile
injection.

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

Spawn Claude co-workers with their role file appended to the brief.

## Design notes

- Instructions are **text** — lossless, diffable, cacheable. Do not convert them
  to images.
- Keep the profile set small. Add a new role only when a behavior repeats and
  re-writing its instruction each time is clearly wasteful.
- The full philosophy behind these files: *Giáo Án Herdr — First edition*.
