# codex ⇄ claude bridge

A local server that lets **Codex CLI drive Claude**. Codex thinks it is talking to
an OpenAI model; it is actually talking to the `claude` CLI already installed on
this machine.

```
codex ──POST /v1/responses──▶ bridge ──`claude -p`──▶ Claude
                                 │
codex ◀──SSE function_call───────┘
   │
   └─ codex executes the tool, returns function_call_output, loop repeats
```

**Claude decides. Codex executes.** Claude runs with its own tools switched off;
every action it wants goes back to Codex as a real `function_call`, which Codex
runs inside its own sandbox and approval policy.

## Requirements

- `codex` CLI (tested on 0.153.4)
- `claude` CLI, logged in (tested on 2.1.263)
- Node.js 18+ (tested on 22)

No npm dependencies.

## Quick start

```bash
./bridgectl setup          # wire codex up (writes codex profiles)
./bridgectl start          # start the server in the background
./bridgectl doctor         # confirm everything is healthy

codex --profile claude "add a --json flag and run the tests"
```

No API key is required. The bridge binds to 127.0.0.1 and ignores auth, and the
profiles deliberately omit `env_key` — declaring one is what makes codex refuse
to start with `Missing environment variable`.

## Managing it — `bridgectl`

| Command | What it does |
|---|---|
| `setup` | Writes `~/.codex/claude.config.toml` as a **codex profile**. Your main config is untouched; use `codex --profile claude`. |
| `setup --global` | Edits `~/.codex/config.toml` so Claude becomes your **default** model. Backs the file up first and is fully reversible. |
| `start` / `stop` / `restart` | Background server, PID-tracked. |
| `run` | Foreground, logs to the terminal. |
| `status` | Process, health and codex wiring at a glance. |
| `logs [N \| -f]` | Last N lines (default 80), or follow. |
| `doctor [--quick]` | Full diagnosis. `--quick` skips the live model calls. |
| `test` | End-to-end smoke test through real codex. |
| `use-codex` | Puts `~/.codex/config.toml` back on your own model. Profiles and the running server are kept. |
| `use-claude` | Points it back at the bridge (same as `setup --global`). |
| `uninstall` | Removes the wiring and stops the server. |

Bridge options live in `~/.codex-claude-bridge/env` (sourced on start):

```sh
BRIDGE_CLAUDE_MODEL=sonnet   # much cheaper than the Opus default
BRIDGE_PORT=8787
```

### Which setup should I use?

`setup` (profile) is the default and the safe one — it adds a file, changes
nothing you already have, and is undone by deleting it. Reach for
`setup --global` only when you want every bare `codex` invocation to go through
Claude.

The `--global` path is careful about TOML scoping: bare keys written after a
`[table]` header would silently become part of that table, so the root
`model`/`model_provider` keys are inserted at the **top** of the file and the
`[model_providers.*]` table is appended at the **bottom**. Any root
`model`/`model_provider` you already had is commented out with a marker and
restored on `uninstall`.

Once it is global, `use-codex` and `use-claude` are the cheap toggle between the
two, with no reinstall either way:

```sh
./bridgectl use-codex     # back to your own model (gpt-…); profiles stay installed
./bridgectl use-claude    # back to Claude as the default
```

`use-codex` backs the file up first and restores your commented-out root keys,
so a toggle returns the config to its exact original bytes — `tests/bridgectl.test.mjs`
asserts that over repeated cycles. Restart the Mac app after either, since it
reads the catalog at launch.

## Running the server directly

`bridgectl` is a convenience wrapper. The server is a plain Node script:

```bash
node bridge.mjs
BRIDGE_CLAUDE_MODEL=sonnet BRIDGE_PORT=9000 node bridge.mjs
```

The config it expects on the codex side:

```toml
model = "claude-via-bridge"
model_provider = "claudebridge"

[model_providers.claudebridge]
name = "Claude Bridge"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `8787` | Listen port |
| `BRIDGE_HOST` | `127.0.0.1` | Listen address |
| `BRIDGE_CLAUDE_MODEL` | Claude Code's default | `sonnet`, `opus`, `claude-opus-5`, … |
| `BRIDGE_CLAUDE_EFFORT` | unset | `low`…`max` |
| `BRIDGE_MODE` | `session` | `session` (resume + delta) or `stateless` (full replay) |
| `BRIDGE_WORKDIR` | Codex's cwd | Directory `claude` runs in |
| `BRIDGE_TIMEOUT_MS` | `600000` | Per-turn ceiling |
| `BRIDGE_DEBUG` | off | `1` for verbose logs |
| `BRIDGE_LOG_DIR` | unset | Dump each turn's prompt + output as JSON |

Cost note: every Codex turn is a full Claude turn. Opus is the Claude Code
default; `BRIDGE_CLAUDE_MODEL=sonnet` is much cheaper for routine work.

## Profiles — picking model and effort

`./bridgectl setup` installs a profile per model/effort combination. Switch by
naming one; nothing else changes.

```bash
codex --profile claude        "routine task"     # sonnet, low   — cheapest
codex --profile claude-xhigh  "hard refactor"    # opus 5, xhigh
codex --profile sol-high      "task"             # codex gpt-5.6-sol, no bridge
```

| profile | model | effort | via |
|---|---|---|---|
| `claude` | claude-sonnet-5 | low | bridge |
| `claude-low` … `claude-max` | claude-opus-5 | low / medium / high / xhigh / max | bridge |
| `claude-sonnet` | claude-sonnet-5 | medium | bridge |
| `claude-haiku` | claude-haiku-4-5 | low | bridge |
| `sol-low` / `sol-medium` / `sol-high` | gpt-5.6-sol | low / medium / high | OpenAI direct |

`./bridgectl profiles` lists whatever is installed. Edit the `CLAUDE_PROFILES`
and `CODEX_PROFILES` tables near the top of `bridgectl` to add your own, then
re-run `setup`.

### How it works

Codex forwards its configured reasoning effort on every request
(`reasoning: {effort: "xhigh"}`), and the model name it was launched with. The
bridge reads both per request and maps them onto `claude --model` / `--effort`,
so one running server serves every profile — no restart, no second port.

Codex's effort ladder is one rung longer than Claude's, so `minimal` clamps to
`low` and `ultra` to `max`.

`BRIDGE_CLAUDE_MODEL` / `BRIDGE_CLAUDE_EFFORT` still exist but are now **hard
overrides** — set either and it wins over every profile. Leave them unset for
per-profile control.

The `sol-*` profiles do not touch the bridge at all; they are ordinary codex
profiles kept alongside so you can A/B the two engines on the same task.
## Cost

Every Codex turn is a full Claude turn, so cost scales with **turns x cached
prefix**, not with how much text you send. All figures below are the same
7-turn bug-fix task run end to end through the bridge.

| config | turns | cost | vs baseline |
|---|---|---|---|
| opus, default effort (original default) | 7 | ~$0.37 | — |
| `sonnet` | 7 | $0.1480 | **-60%** |
| `sonnet` + turn batching | 6 | $0.1455 | -61% |
| `sonnet` + batching + `effort=low` | **4** | **$0.1255** | **-66%** |
| `BRIDGE_MODE=stateless` | 5 | $0.2721 | **+84%** |

The shipped defaults are the -66% row. Turn batching is part of the prompt
contract, not a setting.

### Why context rewriting makes it worse

The obvious optimisation — index the conversation and rebuild a smaller
context each turn (a "graph", a summariser, retrieval) — is a **net loss**,
and `stateless` mode above measures it: 84% more expensive.

The reason is that prompt caching already provides the discount such a scheme
is chasing. In the session-mode run the input token mix was:

- fresh, full price: **0.0%**
- cache read @ ~10% of list: **87.3%**
- cache write @ ~125%: 12.7%

Caching matches on the **prefix**, from byte zero. Anything that reorders,
prunes or re-summarises earlier turns invalidates every token after the edit,
trading a 10x discount for a ~30% token reduction. Cost by line item:
cache *writes* 49%, cache reads 27%, output 24% — and 77% of the write cost
is turn 1 alone (the 17KB codex instruction blob plus the tool schema).

Content-addressed dedup of tool results is the one variant that is cache-safe,
because it is append-only. Measured over 153 real codex sessions (8,648 tool
results, 36.6M chars) exact duplication is **3.6%** — worth 1-2% of total cost
for a lot of machinery. Not implemented, deliberately.

### Measuring your own workload

```bash
BRIDGE_COST_LOG=~/bridge-cost.jsonl ./bridgectl restart
```

Writes one JSON line per turn: forwarded items, prompt/system/schema sizes,
fresh vs cached vs written tokens, output tokens and cost.

```bash
node cost-report.mjs ~/bridge-cost.jsonl          # markdown; add --json for the raw summary
```

Sums the per-attempt records — the per-request records repeat those same costs,
and are used instead to reconcile the log. The report says so when it cannot be
trusted as a complete total: repeated records (a log merged or appended twice)
are counted once, attempts a request record says are missing mark the total as
truncated, and costs that disagree with the request record's own total are
flagged rather than silently summed. Failed attempts are broken out by error
type, so the spend that bought nothing is visible.

## How it works

**Wire protocol.** Since February 2026 Codex only supports
`wire_api = "responses"` — Chat Completions is gone. The bridge implements
`POST /v1/responses` with SSE and emits exactly the events Codex's parser
consumes: `response.created`, `response.output_item.added`,
`response.output_text.delta`, `response.output_item.done`, `response.completed`.
SSE comments are sent every 10s as keep-alive so long Claude turns do not trip
Codex's idle-stream timeout.

**Tool fidelity.** Codex sends its tool schemas (`exec_command`, `write_stdin`,
`view_image`, the goal tools, …) on every request. The bridge compiles them into
one JSON Schema — a discriminated union, `const` on the tool name and the tool's
real parameter schema for its arguments — and passes it to
`claude --json-schema`. Claude's reply is therefore *schema-guaranteed* to use
the argument keys Codex expects (`cmd`, not `command`). Each entry becomes a
`function_call` item with a fresh `call_id`; Codex executes it and returns a
`function_call_output` on the next request.

Several calls in one reply are emitted as several items, and Codex runs them in
parallel.

**Why Claude's tools are off.** `claude -p --tools ""` removes Read/Edit/Bash.
Claude cannot touch the filesystem itself, so the only route to action is the
`tool_calls` array — which is what makes Codex the executor rather than a
bystander. Codex's sandbox and approval policy stay fully in force.

**Prompting.** Codex's ~17KB `instructions` blob is written for a model with
direct tool access, so passing it through verbatim makes Claude try to call
`exec_command` natively and report the tool as broken. The bridge instead wraps
it in `<codex_agent_briefing>` as background, sandwiched between a preamble and
a contract that define the real channel. A residual-confusion detector catches
the failure mode and re-prompts once.

**Sessions.** Codex replays the whole transcript every turn. Rather than resend
it, the bridge keys a Claude session off Codex's `prompt_cache_key` and forwards
only the new items with `--resume`, which keeps Claude's prompt cache warm. If
the recorded boundary stops matching — compaction, a rewritten history, a stale
session — it silently replays the full transcript in a fresh session.

## Limitations

- **Images are dropped.** Codex `input_image` items become a placeholder.
- **No reasoning passthrough.** Codex asks for `reasoning.encrypted_content`;
  the bridge does not synthesize it. Claude's own reasoning stays in its session.
- **Text deltas are not incremental.** `--json-schema` returns structured output
  only when complete, so a turn's text arrives in one delta. Tool calls are
  unaffected; keep-alives cover the wait.
- **Token accounting is approximate** — Claude's usage mapped onto Codex's
  fields, so Codex's context meter is indicative only.


## The "model metadata not found" warning

```
warning: Model metadata for `claude-via-bridge` not found. Defaulting to
fallback metadata; this can degrade performance and cause issues.
```

Codex prints this because `claude-via-bridge` is not in its built-in model
registry. **It is safe to ignore, and the obvious fix is a trap.**

Renaming the model to something Codex recognises silences the warning — but
for its own flagship names Codex switches to an internal *code-mode* protocol
and sends **zero tool definitions**. Measured on codex 0.153.4:

| `model =` | tools codex sends | warning | bridge works |
|---|---|---|---|
| `claude-via-bridge` (any unknown name) | 9 | shown | yes |
| `gpt-5.5` | 10 | silent | yes |
| `gpt-6-astra` | **0** | silent | **no** |
| `gpt-5.6-luna` | **0** | silent | **no** |

With zero tools Claude has to guess names, and every call comes back
`unsupported call: shell` / `tool exec invoked with incompatible payload`.

So there are two sensible choices:

- **Keep `claude-via-bridge`** (default) — honest label, live with the warning.
- **Use `gpt-5.5`** — silences the warning and still delivers tools, at the
  cost of a misleading name in the codex banner:

  ```bash
  BRIDGE_CODEX_MODEL=gpt-5.5 ./bridgectl setup
  ```

`bridgectl doctor` fails loudly if the configured name is one of the code-mode
models, so you cannot silently end up in the broken state.

### Why it is not fixed by serving /v1/models

Codex refreshes metadata from `GET /v1/models`. The bridge answers with an empty
list, which parses cleanly and leaves only the warning. Serving a *populated*
entry was tried and abandoned: codex's model struct is large, nested and
version-specific (`truncation_policy`, `comp_hash`,
`effective_context_window_percent`, `shell_type`, `tool_mode`, …), so it would
need re-deriving on every codex release — and a body codex cannot decode logs a
*noisier* error than no body at all.
## Troubleshooting

Start with `./bridgectl doctor` — it checks prerequisites, codex wiring,
`wire_api`, the API-key variable, the server, Claude's auth, and a live
end-to-end round trip, and prints the fix for whatever failed.

- `codex exec` hangs at *"Reading additional input from stdin"* — redirect
  stdin: `codex exec "..." < /dev/null`.
- Claude says a tool is unavailable — the confusion detector should recover; if
  it recurs, run with `BRIDGE_DEBUG=1 BRIDGE_LOG_DIR=./turns` and inspect the
  prompt actually sent.
- Nothing reaches the bridge — confirm `model_provider` in `config.toml` matches
  the `[model_providers.<id>]` key, and that the port is free.
