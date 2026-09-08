export const REPO = 'https://github.com/devzahirul/codex_claude_bridgectl';

export const NAV = [
  { href: '#how', label: 'How it works' },
  { href: '#install', label: 'Install' },
  { href: '#profiles', label: 'Profiles' },
  { href: '#commands', label: 'Commands' },
  { href: '#config', label: 'Config' },
  { href: '#cost', label: 'Cost' },
  { href: '#faq', label: 'FAQ' },
];

export const FEATURES = [
  {
    title: 'Claude decides, Codex executes',
    body: "Claude runs with its own tools switched off. Every action it wants comes back as a real function_call that Codex runs inside its own sandbox and approval policy.",
  },
  {
    title: 'Schema-guaranteed tool calls',
    body: "Codex's tool schemas are compiled into one JSON Schema and enforced with claude --json-schema, so Claude emits the argument keys Codex expects - cmd, not command.",
  },
  {
    title: 'No key, no cloud, no deps',
    body: 'Binds to 127.0.0.1, ignores auth, ships zero npm dependencies. It shells out to the claude CLI you are already logged into.',
  },
  {
    title: 'Non-destructive setup',
    body: 'The default install only adds Codex profile files. Your main config is untouched, and global mode backs up and restores byte for byte.',
  },
  {
    title: 'Cache-aware sessions',
    body: "Rather than resend the transcript each turn, the bridge resumes a Claude session keyed off Codex's prompt_cache_key and forwards only new items.",
  },
  {
    title: 'Diagnosable',
    body: 'bridgectl doctor checks prerequisites, wiring, wire_api, the model name, the catalog and health - and prints the fix for whatever failed.',
  },
];

export const PROFILES = [
  ['claude', 'claude-sonnet-5', 'low', 'bridge'],
  ['claude-low', 'claude-opus-5', 'low', 'bridge'],
  ['claude-medium', 'claude-opus-5', 'medium', 'bridge'],
  ['claude-high', 'claude-opus-5', 'high', 'bridge'],
  ['claude-xhigh', 'claude-opus-5', 'xhigh', 'bridge'],
  ['claude-max', 'claude-opus-5', 'max', 'bridge'],
  ['claude-sonnet', 'claude-sonnet-5', 'medium', 'bridge'],
  ['claude-haiku', 'claude-haiku-4-5', 'low', 'bridge'],
  ['sol-low / sol-medium / sol-high', 'gpt-5.6-sol', 'low / medium / high', 'OpenAI direct'],
];

export const COMMANDS = [
  ['setup', 'Write the Codex profiles. Main config untouched.'],
  ['setup --global', 'Also make Claude the default model (backs up config first).'],
  ['start / stop / restart', 'Background server, PID-tracked, waits for health.'],
  ['run', 'Run in the foreground, logging to the terminal.'],
  ['status', 'Process, health and Codex wiring at a glance.'],
  ['profiles', 'List installed profiles with model, effort and route.'],
  ['logs [N | -f]', 'Last N lines (default 80), or follow.'],
  ['doctor', 'Local diagnosis. No model spend.'],
  ['doctor --live', 'Adds a real Claude call and a real SSE round trip.'],
  ['test', 'End-to-end smoke test through real codex in a temp dir.'],
  ['use-codex / use-claude', 'Toggle the main config between OpenAI and the bridge.'],
  ['uninstall', 'Remove wiring, restore your config, stop the server.'],
];

export const CONFIG = [
  ['BRIDGE_PORT', '8787', 'Listen port'],
  ['BRIDGE_HOST', '127.0.0.1', 'Listen address'],
  ['BRIDGE_CLAUDE_MODEL', 'unset', 'Hard override, wins over every profile'],
  ['BRIDGE_CLAUDE_EFFORT', 'unset', 'Hard override: low ... max'],
  ['BRIDGE_MODE', 'session', 'session (resume + delta) or stateless (full replay)'],
  ['BRIDGE_WORKDIR', "Codex's cwd", 'Directory claude runs in'],
  ['BRIDGE_TIMEOUT_MS', '600000', 'Per-turn ceiling'],
  ['BRIDGE_MAX_ATTEMPTS', '2', 'Retries per turn, clamped to 1-4'],
  ['BRIDGE_DEBUG', 'off', '1 for verbose logs'],
  ['BRIDGE_LOG_DIR', 'unset', "Dump each turn's prompt and output as JSON"],
  ['BRIDGE_COST_LOG', 'unset', 'Append one JSON line of cost data per turn'],
];

export const COST = [
  ['opus, default effort (original default)', '7', '~$0.37', ''],
  ['sonnet', '7', '$0.1480', '-60%'],
  ['sonnet + turn batching', '6', '$0.1455', '-61%'],
  ['sonnet + batching + effort=low (shipped)', '4', '$0.1255', '-66%'],
  ['BRIDGE_MODE=stateless', '5', '$0.2721', '+84%'],
];

export const FAQ = [
  {
    q: 'Do I need an API key?',
    a: 'No. The bridge binds to loopback and ignores auth, and it drives the claude CLI you are already logged into. The profiles deliberately omit env_key, because declaring one makes Codex refuse to start.',
  },
  {
    q: 'Will this change my Codex setup?',
    a: 'Not in the default mode. bridgectl setup only adds profile files, so you opt in per invocation with codex --profile claude. Global mode is opt-in, backed up, and reversible byte for byte.',
  },
  {
    q: 'Why does Codex warn about missing model metadata?',
    a: 'Because the model name is not in its built-in registry. It is safe to ignore. Renaming to a Codex flagship name silences it but can switch Codex into a code-mode protocol that sends zero tool definitions, which breaks the bridge. doctor fails loudly if you land on such a name.',
  },
  {
    q: 'Is a smaller, rewritten context cheaper?',
    a: 'No - it measured 84% more expensive. Prompt caching already discounts the prefix by ~10x, and any reordering or summarising invalidates every token after the edit.',
  },
  {
    q: 'What are the known limitations?',
    a: 'Images are dropped, there is no reasoning passthrough, text deltas arrive in one chunk rather than incrementally, and token accounting is approximate.',
  },
  {
    q: 'Which platforms work?',
    a: 'macOS and Linux, Node 18+. It uses bash, curl and lsof, plus the codex and claude CLIs.',
  },
];
