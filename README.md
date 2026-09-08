# codex-claude bridge

A local server that lets the **Codex CLI drive Claude**. Codex believes it is
talking to an OpenAI model over the Responses API; it is actually talking to the
`claude` CLI already installed on your machine.

```
codex --POST /v1/responses--> bridge --claude -p--> Claude
                                 |
codex <--SSE function_call-------+
   |
   +- codex executes the tool, returns function_call_output, loop repeats
```

**Claude decides. Codex executes.** Claude runs with its own tools switched off,
so every action it wants goes back to Codex as a real `function_call`, which
Codex runs inside its own sandbox and approval policy.

- No API key, no npm dependencies, no cloud component.
- Binds to `127.0.0.1` only.
- Installs as a Codex *profile* by default, so your existing config is untouched.

---

## Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Adding bridgectl to your PATH](#adding-bridgectl-to-your-path)
4. [Setup: profile vs global](#setup-profile-vs-global)
5. [Everyday use](#everyday-use)
6. [Profiles](#profiles)
7. [Command reference](#command-reference)
8. [Configuration](#configuration)
9. [Files this project writes](#files-this-project-writes)
10. [Cost](#cost)
11. [How it works](#how-it-works)
12. [The model-metadata warning](#the-model-metadata-warning)
13. [Limitations](#limitations)
14. [Troubleshooting](#troubleshooting)
15. [Development](#development)
16. [Uninstall](#uninstall)

---

## Requirements

| Requirement | Notes |
|---|---|
| macOS or Linux | Uses `bash`, `curl`, `lsof` |
| Node.js 18+ | Tested on 22. No packages to install. |
| `codex` CLI | Tested on 0.153.4 |
| `claude` CLI | Tested on 2.1.263, **must already be logged in** |

Verify before you start:

```bash
node --version      # v18 or newer
codex --version
claude --version
claude -p "say ok"  # must answer without prompting for login
```

If `claude` asks you to log in, run `claude` once interactively and complete the
login. The bridge shells out to the CLI and inherits that session; it never sees
or stores credentials.

---

## Installation

```bash
git clone https://github.com/devzahirul/codex_claude_bridgectl.git
cd codex_claude_bridgectl
chmod +x bridgectl              # only needed if the exec bit did not survive
./bridgectl doctor              # prerequisite check, no model spend
```

There is nothing to build and nothing to install globally. The repository
directory *is* the installation; `bridgectl` resolves its own location (through
symlinks) to find `bridge.mjs`, so you can keep it anywhere you like.

A conventional home:

```bash
git clone https://github.com/devzahirul/codex_claude_bridgectl.git ~/.local/share/codex-claude-bridge
cd ~/.local/share/codex-claude-bridge
```

At this point `doctor` will report the wiring as missing. That is expected until
you run `setup`.

---

## Adding bridgectl to your PATH

Optional but recommended, so you can type `bridgectl` from any directory instead
of `./bridgectl`.

`bridgectl` deliberately resolves symlinks before locating `bridge.mjs`, so a
symlink into a bin directory is the clean approach - do **not** copy the file on
its own, or it will not find the server.

### Option A - symlink into a bin directory (recommended)

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bridgectl" ~/.local/bin/bridgectl
```

If `~/.local/bin` is not already on your PATH, add it:

```bash
# zsh (macOS default)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

System-wide instead (needs sudo, and puts it on every user's PATH):

```bash
sudo ln -sf "$PWD/bridgectl" /usr/local/bin/bridgectl
```

### Option B - PATH entry for the repo itself

```bash
echo "export PATH=\"$PWD:\$PATH\"" >> ~/.zshrc && source ~/.zshrc
```

Simplest, but it puts the whole repo on your PATH, so `bridge.mjs` becomes
invocable too. Option A is tidier.

### Verify

```bash
which bridgectl        # -> /Users/you/.local/bin/bridgectl
bridgectl help
bridgectl doctor
```

From here on this document writes `bridgectl`; if you skipped this section, use
`./bridgectl` from inside the repo instead. Everything else is identical.

> **Note:** the PATH entry only affects your interactive shell. The bridge
> server itself is always launched by `bridgectl` using an absolute path, so a
> missing PATH entry can never break a running bridge.

---

## Setup: profile vs global

### Quick start (profile mode - the safe default)

```bash
bridgectl setup      # writes codex profiles; your main config is untouched
bridgectl start      # start the server in the background
bridgectl doctor     # confirm everything is healthy

codex --profile claude "add a --json flag and run the tests"
```

`setup` only *adds* files. Undo it by deleting them, or with
`bridgectl uninstall`.

### Global mode

```bash
bridgectl setup --global     # claude becomes your default codex model
codex exec "your task" < /dev/null
```

This edits `~/.codex/config.toml` so bare `codex` goes through the bridge. It
backs the file up first and is fully reversible.

The global path is careful about TOML scoping: bare keys written after a
`[table]` header would silently become part of that table, so the root
`model` / `model_provider` / `model_reasoning_effort` / `model_catalog_json`
keys are inserted at the **top** of the file and the `[model_providers.*]`
table is appended at the **bottom**. Any root keys you already had are commented
out with a marker and restored on `uninstall`.

Once global, toggle without reinstalling:

```bash
bridgectl use-codex      # back to your own model; profiles stay installed
bridgectl use-claude     # back to the bridge
```

Each toggle backs the config up and restores your commented-out root keys, so a
round trip returns the file to its exact original bytes -
`tests/bridgectl.test.mjs` asserts this over repeated cycles. Restart the Codex
desktop app after either, since it reads the catalog at launch.

### Which should I use?

Use **profile mode** unless you want every bare `codex` invocation to go through
Claude. Profile mode changes nothing you already have.

---

## Everyday use

```bash
bridgectl start                                # once per boot
codex --profile claude "routine task"          # sonnet, low effort - cheapest
codex --profile claude-xhigh "hard refactor"   # opus 5, xhigh
codex --profile sol-high "task"                # codex gpt-5.6-sol, no bridge

bridgectl status                               # is it up? is codex wired?
bridgectl logs -f                              # follow the log
bridgectl stop
```

The server is shared: one running bridge serves every profile, and switching
model or effort needs no restart.

---

## Profiles

`setup` installs one Codex profile per model/effort combination. Switch by
naming one; nothing else changes.

| profile | model | effort | via |
|---|---|---|---|
| `claude` | claude-sonnet-5 | low | bridge |
| `claude-low` | claude-opus-5 | low | bridge |
| `claude-medium` | claude-opus-5 | medium | bridge |
| `claude-high` | claude-opus-5 | high | bridge |
| `claude-xhigh` | claude-opus-5 | xhigh | bridge |
| `claude-max` | claude-opus-5 | max | bridge |
| `claude-sonnet` | claude-sonnet-5 | medium | bridge |
| `claude-haiku` | claude-haiku-4-5 | low | bridge |
| `sol-low` / `sol-medium` / `sol-high` | gpt-5.6-sol | low / medium / high | OpenAI direct |

`bridgectl profiles` lists whatever is actually installed. To add your own, edit
the `CLAUDE_PROFILES` and `CODEX_PROFILES` tables near the top of `bridgectl`
and re-run `setup`.

The `sol-*` profiles do not touch the bridge at all. They are ordinary Codex
profiles kept alongside so you can A/B the two engines on the same task.

**How the routing works.** Codex sends its configured reasoning effort on every
request (`reasoning: {effort: "xhigh"}`) plus the model name it was launched
with. The bridge reads both per request and maps them onto `claude --model` /
`--effort`. Codex's effort ladder is one rung longer than Claude's, so `minimal`
clamps to `low` and `ultra` to `max`.

`BRIDGE_CLAUDE_MODEL` / `BRIDGE_CLAUDE_EFFORT` are **hard overrides** - set
either and it wins over every profile. Leave them unset for per-profile control.

---

## Command reference

```
bridgectl [--codex-home DIR] [--state-dir DIR] <command>
```

| Command | What it does |
|---|---|
| `setup` | Write the Codex profiles. Main config untouched. |
| `setup --global` | Also edit `~/.codex/config.toml` so Claude is the default model (backs up first). |
| `start` | Start the server in the background, PID-tracked, and wait for health. |
| `stop` | Stop it (TERM, then KILL after 4s). |
| `restart` | Stop then start. |
| `run` | Run in the foreground, logging to the terminal. |
| `status` | Process, health and Codex wiring at a glance. |
| `profiles` | List installed profiles with model, effort and route. |
| `logs [N \| -f]` | Last N lines (default 80), or follow. |
| `doctor` | Local diagnosis. No model spend. |
| `doctor --live` | Adds a real Claude call and a real SSE round trip (small spend). |
| `test` | End-to-end smoke test through real codex in a temp dir. |
| `use-codex` | Point the main config back at OpenAI; profiles and server kept. |
| `use-claude` | Point it back at the bridge (same as `setup --global`). |
| `uninstall` | Remove profiles and global wiring, stop the server. |
| `help` | Usage summary. |

The two global flags let you point setup and diagnostics at a different Codex
home or state directory, which is how the test suite runs without touching your
real configuration.

---

## Configuration

Options live in `~/.codex-claude-bridge/env`, created by `setup` and sourced on
start. Explicit `BRIDGE_*` values in your shell take precedence over that file.

```sh
BRIDGE_CLAUDE_MODEL=sonnet   # hard override; much cheaper than opus
BRIDGE_PORT=8787
```

### Server options (read by `bridge.mjs`)

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `8787` | Listen port |
| `BRIDGE_HOST` | `127.0.0.1` | Listen address |
| `BRIDGE_CLAUDE_BIN` | `claude` | Path to the Claude CLI |
| `BRIDGE_CLAUDE_MODEL` | unset | Hard override: `sonnet`, `opus`, `claude-opus-5`, ... |
| `BRIDGE_CLAUDE_EFFORT` | unset | Hard override: `low`...`max` |
| `BRIDGE_MODE` | `session` | `session` (resume + delta) or `stateless` (full replay) |
| `BRIDGE_WORKDIR` | Codex's cwd | Directory `claude` runs in |
| `BRIDGE_TIMEOUT_MS` | `600000` | Per-turn ceiling |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `BRIDGE_TIMEOUT_MS` | Per-request ceiling |
| `BRIDGE_MAX_ATTEMPTS` | `2` | Retries per turn, clamped to 1-4 |
| `BRIDGE_DEBUG` | off | `1` for verbose logs |
| `BRIDGE_LOG_DIR` | unset | Dump each turn's prompt + output as JSON |
| `BRIDGE_COST_LOG` | unset | Append one JSON line of cost data per turn |

### Setup options (read by `bridgectl`)

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_CODEX_MODEL` | `claude-sonnet-5` | Model name written into the default profile |
| `BRIDGE_CODEX_EFFORT` | `low` | Effort written into the default profile |
| `BRIDGE_CODEX_BIN` | `codex` | Path to the Codex CLI |
| `BRIDGE_CODEX_HOME` / `CODEX_HOME` | `~/.codex` | Where profiles are written |
| `BRIDGE_STATE_DIR` | `~/.codex-claude-bridge` | PID, log and env file |
| `BRIDGE_PROFILE_NAME` | `claude` | Name of the default profile |

After changing `BRIDGE_PORT`, re-run `setup` so the profiles' `base_url`
matches, then `restart`. `doctor` fails loudly if they disagree.

---

## Files this project writes

| Path | Written by | Purpose |
|---|---|---|
| `~/.codex/<profile>.config.toml` | `setup` | One file per profile |
| `~/.codex/claude.models.json` | `setup` | Model catalog so `/model` lists the Claude models |
| `~/.codex/openai.models.json` | `setup` | Codex's bundled catalog, for the `sol-*` profiles |
| `~/.codex/config.toml` | `setup --global` only | Root keys + provider block, between markers |
| `~/.codex/config.toml.bak.<timestamp>` | `setup --global`, `use-codex`, `uninstall` | Automatic backup |
| `~/.codex-claude-bridge/env` | `setup` | Your options |
| `~/.codex-claude-bridge/bridge.pid` | `start` | PID tracking |
| `~/.codex-claude-bridge/bridge.log` | `start` | Server log |

Nothing is written outside `~/.codex` and `~/.codex-claude-bridge`.

### Running the server directly

`bridgectl` is a convenience wrapper. The server is a plain Node script:

```bash
node bridge.mjs
BRIDGE_CLAUDE_MODEL=sonnet BRIDGE_PORT=9000 node bridge.mjs
```

The minimum Codex-side config it expects:

```toml
model = "claude-sonnet-5"
model_provider = "claudebridge"
model_reasoning_effort = "low"

[model_providers.claudebridge]
name = "Claude Bridge"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
```

No API key is required: the bridge binds to loopback and ignores auth. Omitting
`env_key` is deliberate - declaring one makes Codex refuse to start with
`Missing environment variable`.

See `codex-provider.toml` for a copy-pasteable version, but prefer `setup`,
which also installs the model catalogs that make `/model` work.

---

## Cost

Every Codex turn is a full Claude turn, so cost scales with **turns x cached
prefix**, not with how much text you send. All figures below are the same
7-turn bug-fix task run end to end through the bridge.

| config | turns | cost | vs baseline |
|---|---|---|---|
| opus, default effort (original default) | 7 | ~$0.37 | - |
| `sonnet` | 7 | $0.1480 | **-60%** |
| `sonnet` + turn batching | 6 | $0.1455 | -61% |
| `sonnet` + batching + `effort=low` | **4** | **$0.1255** | **-66%** |
| `BRIDGE_MODE=stateless` | 5 | $0.2721 | **+84%** |

The shipped defaults are the -66% row. Turn batching is part of the prompt
contract, not a setting.

### Why context rewriting makes it worse

The obvious optimisation - index the conversation and rebuild a smaller context
each turn (a graph, a summariser, retrieval) - is a **net loss**, and
`stateless` mode above measures it: 84% more expensive.

Prompt caching already provides the discount such a scheme is chasing. In the
session-mode run the input token mix was:

- fresh, full price: **0.0%**
- cache read at ~10% of list: **87.3%**
- cache write at ~125%: 12.7%

Caching matches on the **prefix**, from byte zero. Anything that reorders,
prunes or re-summarises earlier turns invalidates every token after the edit,
trading a 10x discount for a ~30% token reduction. By line item: cache *writes*
49%, cache reads 27%, output 24% - and 77% of the write cost is turn 1 alone
(the 17KB codex instruction blob plus the tool schema).

Content-addressed dedup of tool results is the one variant that is cache-safe,
because it is append-only. Measured over 153 real codex sessions (8,648 tool
results, 36.6M chars) exact duplication is **3.6%** - worth 1-2% of total cost
for a lot of machinery. Not implemented, deliberately.

### Measuring your own workload

```bash
BRIDGE_COST_LOG=~/bridge-cost.jsonl bridgectl restart
```

Writes one JSON line per turn: forwarded items, prompt/system/schema sizes,
fresh vs cached vs written tokens, output tokens and cost.

```bash
node cost-report.mjs ~/bridge-cost.jsonl        # markdown; --json for raw summary
```

The report sums the per-attempt records and reconciles them against the
per-request records. It says so when the total cannot be trusted: repeated
records (a log merged or appended twice) are counted once, attempts a request
record says are missing mark the total as truncated, and costs that disagree
with the request record's own total are flagged rather than silently summed.
Failed attempts are broken out by error type, so spend that bought nothing is
visible.

---

## How it works

**Wire protocol.** Since February 2026 Codex only supports
`wire_api = "responses"` - Chat Completions is gone. The bridge implements
`POST /v1/responses` with SSE and emits exactly the events Codex's parser
consumes: `response.created`, `response.output_item.added`,
`response.output_text.delta`, `response.output_item.done`, `response.completed`.
SSE comments are sent every 10s as keep-alive so long Claude turns do not trip
Codex's idle-stream timeout. `GET /health` and `GET /` return status;
`GET /v1/models` answers with an empty list.

**Tool fidelity.** Codex sends its tool schemas (`exec_command`, `write_stdin`,
`view_image`, the goal tools, ...) on every request. The bridge compiles them
into one JSON Schema - a discriminated union, `const` on the tool name and the
tool's real parameter schema for its arguments - and passes it to
`claude --json-schema`. Claude's reply is therefore *schema-guaranteed* to use
the argument keys Codex expects (`cmd`, not `command`). Each entry becomes a
`function_call` item with a fresh `call_id`; Codex executes it and returns a
`function_call_output` on the next request. Several calls in one reply are
emitted as several items, and Codex runs them in parallel.

**Why Claude's tools are off.** `claude -p --tools ""` removes Read/Edit/Bash.
Claude cannot touch the filesystem itself, so the only route to action is the
tool-call array - which is what makes Codex the executor rather than a
bystander. Codex's sandbox and approval policy stay fully in force.

**Prompting.** Codex's ~17KB `instructions` blob is written for a model with
direct tool access, so passing it through verbatim makes Claude try to call
`exec_command` natively and report the tool as broken. The bridge instead wraps
it in `<codex_agent_briefing>` as background, sandwiched between a preamble and
a contract that define the real channel. A residual-confusion detector catches
the failure mode and re-prompts once (`BRIDGE_MAX_ATTEMPTS`).

**Sessions.** Codex replays the whole transcript every turn. Rather than resend
it, the bridge keys a Claude session off Codex's `prompt_cache_key` and forwards
only the new items with `--resume`, which keeps Claude's prompt cache warm. If
the recorded boundary stops matching - compaction, a rewritten history, a stale
session - it silently replays the full transcript in a fresh session.

---

## The model-metadata warning

```
warning: Model metadata for `claude-via-bridge` not found. Defaulting to
fallback metadata; this can degrade performance and cause issues.
```

Codex prints this when the configured model name is not in its built-in
registry. **It is safe to ignore, and the obvious fix is a trap.**

Renaming the model to something Codex recognises silences the warning - but for
its own flagship names Codex switches to an internal *code-mode* protocol and
sends **zero tool definitions**. Measured on codex 0.153.4:

| `model =` | tools codex sends | warning | bridge works |
|---|---|---|---|
| `claude-sonnet-5` / any unknown name | 9 | shown | yes |
| `gpt-5.5` | 10 | silent | yes |
| `gpt-6-astra` | **0** | silent | **no** |
| `gpt-5.6-luna` | **0** | silent | **no** |

With zero tools Claude has to guess names, and every call comes back
`unsupported call: shell` / `tool exec invoked with incompatible payload`.

Two sensible choices:

- **Keep the default name** - honest label, live with the warning.
- **Use `gpt-5.5`** - silences the warning and still delivers tools, at the cost
  of a misleading name in the codex banner:

  ```bash
  BRIDGE_CODEX_MODEL=gpt-5.5 bridgectl setup
  ```

`bridgectl doctor` fails loudly if the configured name is a known code-mode
model, so you cannot silently end up in the broken state.

**Why not just serve `/v1/models`?** Codex refreshes metadata from that
endpoint. The bridge answers with an empty list, which parses cleanly and leaves
only the warning. Serving a *populated* entry was tried and abandoned: Codex's
model struct is large, nested and version-specific (`truncation_policy`,
`comp_hash`, `effective_context_window_percent`, `shell_type`, `tool_mode`, ...),
so it would need re-deriving on every Codex release - and a body Codex cannot
decode logs a *noisier* error than no body at all. `setup` installs a
`model_catalog_json` file instead, which is what makes `/model` list the Claude
models.

---

## Limitations

- **Images are dropped.** Codex `input_image` items become a placeholder.
- **No reasoning passthrough.** Codex asks for `reasoning.encrypted_content`;
  the bridge does not synthesize it. Claude's own reasoning stays in its session.
- **Text deltas are not incremental.** `--json-schema` returns structured output
  only when complete, so a turn's text arrives in one delta. Tool calls are
  unaffected; keep-alives cover the wait.
- **Token accounting is approximate** - Claude's usage mapped onto Codex's
  fields, so Codex's context meter is indicative only.
- **One machine, one user.** No auth, loopback only. Do not expose the port.

---

## Troubleshooting

Start with `bridgectl doctor`. It checks prerequisites, Codex wiring,
`wire_api`, the model name, the catalog, the server and health, and prints the
fix for whatever failed. Add `--live` to also verify Claude's auth and a real
end-to-end round trip.

| Symptom | Fix |
|---|---|
| `codex exec` hangs at *Reading additional input from stdin* | Redirect stdin: `codex exec "..." < /dev/null` |
| `port 8787 is held by pid N` | Stop that process, or set `BRIDGE_PORT` and re-run `setup` |
| Claude says a tool is unavailable | The confusion detector should recover. If it recurs, run with `BRIDGE_DEBUG=1 BRIDGE_LOG_DIR=./turns` and inspect the prompt actually sent |
| Nothing reaches the bridge | Confirm `model_provider` matches the `[model_providers.<id>]` key and that the bridge is running |
| `Missing environment variable` from codex | A profile declares `env_key`; re-run `setup` to drop it |
| `not authenticated` in `doctor --live` | Run `claude` interactively and log in |
| Desktop app still on the old model | `setup --global`, then restart the app - it reads the catalog at launch |
| `bridge did not become healthy` | `bridgectl logs 40` shows the startup error |

---

## Development

```bash
node --test 'tests/*.test.mjs'   # full suite (42 tests), no network and no model spend
node --check bridge.mjs       # syntax only
bridgectl test                # end-to-end through real codex (spends usage)
```

| File | Role |
|---|---|
| `bridge.mjs` | The server: Responses API in, `claude -p` out |
| `bridgectl` | Setup, process management and diagnostics |
| `model-catalog.mjs` | Generates the Claude model catalog Codex reads |
| `cost-report.mjs` | Turns a `BRIDGE_COST_LOG` file into a report |
| `graph-context.mjs` | Standalone, bounded Graphify retrieval experiment. Not wired into the bridge - see [Why context rewriting makes it worse](#why-context-rewriting-makes-it-worse) |
| `codex-provider.toml` | Reference provider config for manual installs |
| `tests/` | `node:test` suites for each module |

The tests drive `bridgectl` with `--codex-home` and `--state-dir` pointed at
temp directories, so they never touch your real `~/.codex`.

---

## Uninstall

```bash
bridgectl uninstall            # remove profiles + global wiring, stop the server
rm -rf ~/.codex-claude-bridge  # optional: drop logs and saved options
rm -f ~/.local/bin/bridgectl   # optional: if you symlinked it onto your PATH
```

`uninstall` restores any root keys it commented out in `~/.codex/config.toml`
and leaves a timestamped backup beside it. Then delete the cloned directory.

---

## License

MIT - see [LICENSE](LICENSE).
