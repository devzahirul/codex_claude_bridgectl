#!/usr/bin/env node
/**
 * codex <-> claude bridge
 *
 * A local server that speaks the OpenAI **Responses API** (the only wire
 * protocol Codex CLI supports since Feb 2026) on one side, and drives the
 * locally installed `claude` CLI in headless mode on the other.
 *
 *   codex ──POST /v1/responses──▶ bridge ──`claude -p`──▶ Claude
 *                                   │
 *   codex ◀──SSE function_call───────┘   (Claude decides, Codex executes)
 *   codex executes the tool, returns function_call_output, loop repeats.
 *
 * Claude runs with its own tools disabled (`--tools ""`). Codex's tool
 * schemas are compiled into a JSON Schema and enforced with `--json-schema`,
 * so Claude emits argument keys that Codex accepts verbatim.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CFG = {
  port: Number(process.env.BRIDGE_PORT || 8787),
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  claudeBin: process.env.BRIDGE_CLAUDE_BIN || 'claude',
  model: process.env.BRIDGE_CLAUDE_MODEL || '',        // '' = Claude Code default
  effort: process.env.BRIDGE_CLAUDE_EFFORT || '',      // low|medium|high|xhigh|max
  mode: process.env.BRIDGE_MODE || 'session',          // 'session' | 'stateless'
  workdir: process.env.BRIDGE_WORKDIR || '',           // '' = codex's cwd
  timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 600000),
  debug: process.env.BRIDGE_DEBUG === '1',
  logDir: process.env.BRIDGE_LOG_DIR || '',
  maxAttempts: Math.max(1, Math.min(4, Math.floor(Number(process.env.BRIDGE_MAX_ATTEMPTS)) || 2)),
  requestTimeoutMs: Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS || process.env.BRIDGE_TIMEOUT_MS || 600000),
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claude-bridge-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const log = (...a) => console.error('[bridge]', ...a);
const dbg = (...a) => { if (CFG.debug) console.error('[bridge:debug]', ...a); };

/* ────────────────────────────── schema ────────────────────────────── */

/** Codex tool params -> a schema the structured-output validator accepts. */
function sanitizeParams(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  const out = JSON.parse(JSON.stringify(schema));
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    // Structured outputs reject unknown//annotation-only keywords in some positions.
    delete node.$schema;
    delete node.default;
    if (node.type === 'object' && node.additionalProperties === undefined) node.additionalProperties = false;
    for (const k of Object.keys(node)) walk(node[k]);
  })(out);
  return out;
}

/** Build the discriminated-union schema Claude must answer with. */
function buildSchema(tools, { loose = false } = {}) {
  const fns = (tools || []).filter((t) => t && t.type === 'function' && t.name);
  const callSchema = loose || fns.length === 0
    ? {
        type: 'object',
        properties: {
          name: fns.length ? { type: 'string', enum: fns.map((t) => t.name) } : { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      }
    : {
        anyOf: fns.map((t) => ({
          type: 'object',
          properties: {
            name: { type: 'string', const: t.name },
            arguments: sanitizeParams(t.parameters),
          },
          required: ['name', 'arguments'],
          additionalProperties: false,
        })),
      };

  return {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'Prose for the user. Brief narration when you are also calling tools; ' +
          'your complete final answer when tool_calls is empty.',
      },
      tool_calls: {
        type: 'array',
        description: 'Tools for the harness to execute. Empty array ends your turn.',
        items: callSchema,
      },
    },
    required: ['message', 'tool_calls'],
    additionalProperties: false,
  };
}

/* ─────────────────── per-request model / effort ─────────────────── */

// Codex sends its configured reasoning effort on every request; Claude takes a
// slightly different ladder, so map it. minimal->low and ultra->max are clamps.
const EFFORT_MAP = {
  minimal: 'low', low: 'low', medium: 'medium',
  high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max',
};

// A codex profile names the Claude model directly (model = "claude-opus-5").
// The legacy placeholder means "whatever Claude Code defaults to".
const PLACEHOLDER_MODELS = new Set(['claude-via-bridge', 'claude-probe', '']);

function resolveModel(codexModel) {
  if (CFG.model) return CFG.model;                 // env override wins
  const m = (codexModel || '').trim();
  if (PLACEHOLDER_MODELS.has(m)) return '';
  if (/^(claude-|opus|sonnet|haiku|fable)/.test(m)) return m;
  throw new Error(`Unsupported bridge model ${JSON.stringify(m)}. Use a Claude model/profile or set BRIDGE_CLAUDE_MODEL explicitly.`);
}

function resolveEffort(reasoning) {
  if (CFG.effort) return CFG.effort;               // env override wins
  const e = reasoning && typeof reasoning.effort === 'string' ? reasoning.effort.toLowerCase() : '';
  return EFFORT_MAP[e] || '';
}

/* ───────────────────────────── prompting ───────────────────────────── */

const PREAMBLE = `# How you operate (highest priority — overrides everything below)

You are the reasoning engine behind a CLI coding agent. A harness executes
tools for you. You have NO ability to invoke tools yourself.

Everything after <codex_agent_briefing> was written for a model with direct
tool access. Treat it as background on the agent you are acting as and on what
the tools do — NOT as permission to call them yourself.

If you try to invoke a tool directly you will get "No such tool available".
That is not a bug and retrying will not help: it means you used the wrong
channel. The only way to run anything is the \`tool_calls\` array of your
structured response.

`;

const CONTRACT = `

# Execution model — this section wins any conflict with the briefing above

Your entire reply is one JSON object with two fields:

- \`tool_calls\` — the actions the harness should run for you. Each result comes
  back as a \`<tool_result>\` block in the next user turn.
- \`message\` — prose for the user: short narration when you are also calling
  tools, or your complete final answer when you are not.

# Turn economy — do the most work per turn

Every turn re-reads the whole conversation, so a round trip is the expensive
unit here, not a long command. Two turns doing half the work each cost roughly
twice one turn doing all of it. Before you answer, ask: *can this turn finish
more?*

- **Batch independent calls.** Put them all in one \`tool_calls\` array; they
  run in parallel. Three files to inspect is one turn, not three.
- **Chain dependent shell steps into one command** with \`&&\`. Applying an edit
  and running the test that proves it is a single \`exec_command\`, not two turns.
  Reading a file and grepping it likewise.
- **Do not spend a turn confirming something you can already infer** — an echo
  to check a path, an \`ls\` to see whether a file you just wrote exists, a
  \`--version\` you do not act on. Fold the check into the command that needs it.
- **Gather in one sweep.** When you begin a task, request everything you know
  you will need at once rather than discovering it one file per turn.

The limit is correctness, not caution: keep a step separate when you genuinely
need to see its output before choosing what comes next, or when chaining would
run something destructive on an unverified assumption. Never chain past a step
whose failure should stop the rest.

**To do work, put it in \`tool_calls\`. To end the turn, send an empty
\`tool_calls\` array with your answer in \`message\`.**

Hard rules:

- Never say you ran a command, read a file, or saw output unless a
  \`<tool_result>\` for it is already in the transcript. You observe nothing the
  harness has not returned.
- Never invent shell output, file contents, or diffs in \`message\`.
- Never describe a command instead of calling it. If work remains, emit the call.
- Never report a tool as broken or unavailable. "No such tool available" only
  means you tried to call it directly — put it in \`tool_calls\` instead.
- Argument keys are fixed by the response schema. Use them exactly (e.g.
  \`cmd\`, not \`command\`).
`;

const TEXT_TYPES = new Set(['input_text', 'output_text', 'text', 'summary_text']);

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return '';
      if (TEXT_TYPES.has(c.type) && typeof c.text === 'string') return c.text;
      if (c.type === 'input_image') return '[image omitted — the bridge cannot forward images]';
      if (typeof c.text === 'string') return c.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Render Codex input items as a transcript for Claude.
 * Skip only outputs whose identity and contents match a response actually
 * emitted from the resumed Claude session. External/revised messages survive.
 */
function renderItems(items, { knownOutputs = new Set() } = {}) {
  const parts = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (knownOutputs.has(outputFingerprint(it))) continue;
    switch (it.type) {
      case 'message': {
        const text = contentToText(it.content);
        if (!text.trim()) break;
        const role = it.role === 'developer' ? 'developer' : it.role === 'assistant' ? 'assistant' : 'user';
        parts.push(`<${role}>\n${text}\n</${role}>`);
        break;
      }
      case 'function_call': {
        parts.push(
          `<assistant_tool_call id="${it.call_id || it.id || ''}">\n${it.name}(${it.arguments || '{}'})\n</assistant_tool_call>`,
        );
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const out = typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? '');
        parts.push(`<tool_result call_id="${it.call_id || ''}">\n${out}\n</tool_result>`);
        break;
      }
      case 'reasoning':
        break; // Claude keeps its own reasoning in-session.
      default: {
        const text = contentToText(it.content);
        if (text.trim()) parts.push(`<${it.type}>\n${text}\n</${it.type}>`);
      }
    }
  }
  return parts.join('\n\n');
}

/** Codex ships cwd inside an <environment_context> block; mirror it for Claude. */
function extractCwd(items) {
  for (const it of items || []) {
    const text = contentToText(it && it.content);
    const m = text && text.match(/<cwd>([^<]+)<\/cwd>/);
    if (m) return m[1].trim();
  }
  return '';
}

/* ─────────────────────────── claude runner ─────────────────────────── */

function runClaude({ systemPrompt, prompt, schema, sessionId, resumeId, cwd, model, effort, signal, timeoutMs = CFG.timeoutMs }) {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'request cancelled', errorType: 'cancelled' });
  const stamp = randomUUID().slice(0, 8);
  const sysFile = path.join(TMP, `sys-${stamp}.txt`);
  fs.writeFileSync(sysFile, systemPrompt);
  const args = [
    '-p', '--tools', '', '--system-prompt-file', sysFile,
    '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--strict-mcp-config', '--permission-prompts', 'none',
  ];
  if (resumeId) args.push('--resume', resumeId);
  else if (sessionId) args.push('--session-id', sessionId);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  return new Promise((resolve) => {
    let child, timer, settled = false, stdout = '', stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { fs.unlinkSync(sysFile); } catch {}
      resolve(result);
    };
    const abort = () => {
      child?.kill('SIGKILL');
      finish({ ok: false, error: 'request cancelled', errorType: 'cancelled' });
    };
    try {
      child = spawn(CFG.claudeBin, args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, error: `failed to spawn ${CFG.claudeBin}: ${error.message}`, errorType: 'spawn' });
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `claude timed out after ${timeoutMs}ms`, errorType: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    // EPIPE can occur when argument validation exits before reading stdin.
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish({ ok: false, error: `failed to spawn ${CFG.claudeBin}: ${error.message}`, errorType: 'spawn' }));
    child.on('close', (code) => {
      if (settled) return;
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {
        const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
        if (line) { try { parsed = JSON.parse(line); } catch {} }
      }
      if (!parsed) return finish({ ok: false, error: `claude exited ${code} without parseable JSON. stderr: ${stderr.slice(0, 800)}` });
      if (parsed.is_error || code !== 0) {
        return finish({ ok: false, error: `claude reported an error: ${String(parsed.result || parsed.subtype || stderr).slice(0, 800)}`, meta: parsed });
      }
      let output = parsed.structured_output;
      if (!output && typeof parsed.result === 'string') { try { output = JSON.parse(parsed.result); } catch {} }
      if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.message !== 'string' || !Array.isArray(output.tool_calls)) {
        return finish({ ok: false, error: 'claude returned no valid structured output', errorType: 'output', meta: parsed });
      }
      finish({ ok: true, output, sessionId: parsed.session_id, meta: parsed });
    });
    child.stdin.end(prompt);
  });
}

/* ──────────────────────────── SSE plumbing ──────────────────────────── */

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let seq = 0;
  return {
    send(type, payload) {
      seq++;
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...payload })}\n\n`);
    },
    ping() { res.write(`: keep-alive ${Date.now()}\n\n`); },
    end() { res.end(); },
  };
}

/** Convert Claude's structured output into Responses output items. */
function toOutputItems(structured, respId) {
  const items = [];
  const message = typeof structured.message === 'string' ? structured.message.trim() : '';
  if (message) {
    items.push({
      id: `msg_${respId}_${items.length}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message, annotations: [] }],
    });
  }
  for (const call of Array.isArray(structured.tool_calls) ? structured.tool_calls : []) {
    if (!call || typeof call.name !== 'string') continue;
    let args = call.arguments;
    if (typeof args !== 'string') { try { args = JSON.stringify(args ?? {}); } catch { args = '{}'; } }
    items.push({
      id: `fc_${respId}_${items.length}`,
      type: 'function_call',
      status: 'completed',
      name: call.name,
      call_id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      arguments: args,
    });
  }
  if (items.length === 0) {
    items.push({
      id: `msg_${respId}_0`, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: '(no output)', annotations: [] }],
    });
  }
  return items;
}

function emitItems(stream, items) {
  items.forEach((item, index) => {
    if (item.type === 'message') {
      stream.send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', content: [] } });
      const text = item.content[0]?.text || '';
      if (text) stream.send('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: text });
      stream.send('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text });
    } else {
      stream.send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
      stream.send('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
    }
    stream.send('response.output_item.done', { output_index: index, item });
  });
}

function usageFrom(meta) {
  const u = meta?.usage;
  if (!u || !Number.isFinite(u.input_tokens) || !Number.isFinite(u.output_tokens)) return null;
  const input = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const output = u.output_tokens;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u.output_tokens_details?.thinking_tokens || 0 },
    total_tokens: input + output,
  };
}

function aggregateUsage(attempts) {
  const usages = attempts.map((a) => usageFrom(a.result.meta));
  if (!usages.length || usages.some((u) => !u)) return null;
  const total = usageFrom({ usage: { input_tokens: 0, output_tokens: 0 } });
  for (const u of usages) {
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.total_tokens += u.total_tokens;
    total.input_tokens_details.cached_tokens += u.input_tokens_details.cached_tokens;
    total.output_tokens_details.reasoning_tokens += u.output_tokens_details.reasoning_tokens;
  }
  return total;
}

function isToolConfused(out) {
  if (!out || (Array.isArray(out.tool_calls) && out.tool_calls.length)) return false;
  return /no such tool|tool\b[^.]{0,30}\b(unavailable|not available)|isn.t available/i.test(String(out.message || ''));
}

// Exact response replay was removed: a coding-agent response can depend on
// external state and may contain commands or process handles that cannot be reused.
// Claude's provider-side prefix caching still works with resumed sessions.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const fingerprint = (value) => createHash('sha256').update(canonical(value)).digest('hex');

function outputFingerprint(item) {
  if (item?.type === 'message' && item.role === 'assistant' && item.id) {
    return fingerprint({ type: item.type, id: item.id, role: item.role, content: item.content });
  }
  if (item?.type === 'function_call' && item.call_id) {
    return fingerprint({ type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments });
  }
  return null;
}

const sessions = new Map();
const pending = new Map();

function planTurn(key, input, contextFingerprint) {
  const full = { items: input, resumeId: null, full: true, knownOutputs: new Set() };
  if (!key || CFG.mode === 'stateless') return full;
  const state = sessions.get(key);
  if (!state || state.contextFingerprint !== contextFingerprint || input.length < state.forwarded ||
      fingerprint(input.slice(0, state.forwarded)) !== state.prefixFingerprint) return full;
  return { items: input.slice(state.forwarded), resumeId: state.claudeSessionId, full: false, knownOutputs: state.knownOutputs };
}

async function serialTurn(key, fn) {
  if (!key) return fn();
  const previous = pending.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  pending.set(key, current);
  try { await previous; return await fn(); }
  finally { release(); if (pending.get(key) === current) pending.delete(key); }
}

function classifyFailure(result) {
  if (result.errorType) return result.errorType;
  const error = String(result.error || '');
  if (/authentication|unauthorized|invalid api key|not logged in|rate.?limit|overloaded|service unavailable/i.test(error)) return 'provider';
  if (/session[^.\n]*(?:not found|does not exist|expired|invalid)|no conversation found|no session found|invalid session/i.test(error)) return 'session';
  if (/json.?schema|schema (?:validation|rejected|invalid)|invalid schema|structured output[^.\n]*schema/i.test(error)) return 'schema';
  return 'other';
}

// Validate emitted calls against their original tool schema even after a loose
// structured-output fallback. Unsupported assertion keywords fail closed.
function validateArguments(value, schema, location = 'arguments') {
  if (schema === true || schema == null) return null;
  if (schema === false) return `${location} is not permitted`;
  const unsupported = ['$ref', '$dynamicRef', 'not', 'if', 'then', 'else', 'contains', 'dependentSchemas', 'unevaluatedProperties', 'unevaluatedItems'];
  if (unsupported.some((k) => k in schema)) return `${location} uses an unsupported validation keyword`;
  if (schema.anyOf && !schema.anyOf.some((s) => !validateArguments(value, s, location))) return `${location} does not match any allowed schema`;
  if (schema.oneOf && schema.oneOf.filter((s) => !validateArguments(value, s, location)).length !== 1) return `${location} must match exactly one schema`;
  if (schema.allOf) for (const branch of schema.allOf) { const error = validateArguments(value, branch, location); if (error) return error; }
  if ('const' in schema && canonical(value) !== canonical(schema.const)) return `${location} has an invalid constant`;
  if (schema.enum && !schema.enum.some((v) => canonical(v) === canonical(value))) return `${location} has an invalid enum value`;
  const matches = (type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
    type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
    type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) return `${location} has the wrong type`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum ||
        schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return `${location} is out of range`;
    if (schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) return `${location} is not an allowed multiple`;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return `${location} has invalid length`;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return `${location} does not match the required pattern`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return `${location} has invalid item count`;
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) return `${location} contains duplicate items`;
    for (let i = 0; i < value.length; i++) {
      const child = schema.prefixItems?.[i] ?? (Array.isArray(schema.items) ? schema.items[i] : schema.items);
      const error = validateArguments(value[i], child, `${location}[${i}]`); if (error) return error;
    }
  } else if (value && typeof value === 'object') {
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) return `${location}.${required} is required`;
    for (const [key, childValue] of Object.entries(value)) {
      const patterns = Object.entries(schema.patternProperties || {}).filter(([pattern]) => new RegExp(pattern, 'u').test(key));
      if (!Object.hasOwn(schema.properties || {}, key) && !patterns.length && schema.additionalProperties === false) return `${location}.${key} is not allowed`;
      const children = [schema.properties?.[key], ...patterns.map(([, child]) => child)];
      if (!children.some((child) => child !== undefined)) children.push(schema.additionalProperties);
      for (const child of children) { const error = validateArguments(childValue, child, `${location}.${key}`); if (error) return error; }
    }
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties || schema.maxProperties !== undefined && count > schema.maxProperties) return `${location} has invalid property count`;
    for (const [name, dependencies] of Object.entries(schema.dependentRequired || {})) {
      if (Object.hasOwn(value, name)) for (const dependency of dependencies) if (!Object.hasOwn(value, dependency)) return `${location}.${dependency} is required`;
    }
  }
  return null;
}

function validateOutput(output, tools) {
  if (!output || typeof output.message !== 'string' || !Array.isArray(output.tool_calls)) return 'invalid structured response';
  for (const call of output.tool_calls) {
    const tool = tools.find((t) => t.type === 'function' && t.name === call?.name);
    if (!tool) return `unsupported tool ${JSON.stringify(call?.name)}`;
    let args = call.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return `invalid JSON arguments for ${tool.name}`; } }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return `arguments for ${tool.name} must be an object`;
    const error = validateArguments(args, tool.parameters); if (error) return `${tool.name}: ${error}`;
  }
  return null;
}

function writeCost(record) {
  if (!process.env.BRIDGE_COST_LOG) return;
  try { fs.appendFileSync(process.env.BRIDGE_COST_LOG, JSON.stringify(record) + '\n'); }
  catch (error) { log('could not write cost log:', error.message); }
}

async function handleResponses(req, res, body, { runner = runClaude } = {}) {
  let payload, model;
  try {
    payload = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('request must be an object');
    if (!Array.isArray(payload.input)) throw new Error('bridge input must be an array of Responses items');
    model = resolveModel(payload.model);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: error.message } }));
  }
  const identity = payload.prompt_cache_key || payload.client_metadata?.thread_id;
  const key = typeof identity === 'string' && identity.trim() ? identity : null;
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); };
  req.on('aborted', cancel);
  res.on('close', cancel);
  // This deadline includes queue waiting and all attempts, not just one child.
  const deadline = Date.now() + CFG.requestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(new Error('request deadline exceeded')), CFG.requestTimeoutMs);
  try {
    return await serialTurn(key, async () => {
      if (res.destroyed) return;
      if (controller.signal.aborted) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'request deadline exceeded while waiting for the session' } }));
      }
      const input = payload.input;
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      const respId = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const cwd = path.resolve(CFG.workdir || extractCwd(input) || process.cwd());
      const effort = resolveEffort(payload.reasoning);
      const briefing = payload.instructions || 'You are a coding agent.';
      const systemPrompt = `${PREAMBLE}<codex_agent_briefing>\n${briefing}\n</codex_agent_briefing>${CONTRACT}`;
      const contextFingerprint = fingerprint({ systemPrompt, tools, model, effort, cwd });
      const plan = planTurn(key, input, contextFingerprint);
      const prompt = renderItems(plan.items, { knownOutputs: plan.knownOutputs }) || '(the harness returned no new content; continue or finish)';
      const base = { systemPrompt, prompt, sessionId: plan.resumeId ? null : randomUUID(), resumeId: plan.resumeId, cwd, model, effort };
      const stream = openStream(res);
      const responseBase = { id: respId, object: 'response', model: payload.model || 'claude-bridge' };
      stream.send('response.created', { response: { ...responseBase, status: 'in_progress', output: [] } });
      stream.send('response.in_progress', { response: { ...responseBase, status: 'in_progress', output: [] } });
      const heartbeat = setInterval(() => { if (!controller.signal.aborted) stream.ping(); }, 10000);
      const attempts = [];
      let result, actualPrompt = prompt;
      const invoke = async (args, reason) => {
        actualPrompt = args.prompt;
        const started = Date.now();
        let attemptResult;
        try {
          attemptResult = await runner({ ...args, signal: controller.signal, timeoutMs: Math.max(1, Math.min(CFG.timeoutMs, deadline - Date.now())) });
        } catch (error) { attemptResult = { ok: false, error: error.message, errorType: 'internal' }; }
        if (attemptResult.ok) {
          let validationError;
          try { validationError = validateOutput(attemptResult.output, tools); } catch (error) { validationError = error.message; }
          if (validationError) attemptResult = { ...attemptResult, ok: false, error: validationError, errorType: 'output' };
        }
        const u = attemptResult.meta?.usage;
        const field = (name) => Number.isFinite(u?.[name]) ? u[name] : null;
        attempts.push({ reason, result: attemptResult });
        writeCost({
          record_type: 'attempt', t: Date.now(), request_id: respId, key, attempt: attempts.length, reason,
          ok: attemptResult.ok, error_type: attemptResult.ok ? null : classifyFailure(attemptResult),
          model_requested: payload.model || null, model_resolved: model || null, effort: effort || null,
          models_reported: Object.keys(attemptResult.meta?.modelUsage || {}),
          codex_items: input.length, prompt_chars: args.prompt.length, system_chars: systemPrompt.length,
          schema_chars: JSON.stringify(args.schema).length, fresh_in: field('input_tokens'),
          cache_read: field('cache_read_input_tokens'), cache_write: field('cache_creation_input_tokens'), out: field('output_tokens'),
          cache_write_5m: Number.isFinite(u?.cache_creation?.ephemeral_5m_input_tokens) ? u.cache_creation.ephemeral_5m_input_tokens : null,
          cache_write_1h: Number.isFinite(u?.cache_creation?.ephemeral_1h_input_tokens) ? u.cache_creation.ephemeral_1h_input_tokens : null,
          cost_usd: Number.isFinite(attemptResult.meta?.total_cost_usd) ? attemptResult.meta.total_cost_usd : null,
          usage_complete: usageFrom(attemptResult.meta) !== null, resumed: !!args.resumeId, duration_ms: Date.now() - started,
        });
        return attemptResult;
      };
      try {
        log(`turn key=${key ? key.slice(0, 8) : '(unkeyed)'} items=${input.length} new=${plan.items.length} model=${model || '(default)'} effort=${effort || '(default)'} ${plan.resumeId ? 'resume' : 'fresh'}`);
        result = await invoke({ ...base, schema: buildSchema(tools) }, 'initial');
        const canRetry = () => !controller.signal.aborted && attempts.length < CFG.maxAttempts && Date.now() < deadline;
        if (!result.ok && canRetry()) {
          const failure = classifyFailure(result);
          if (failure === 'schema' || (failure === 'session' && plan.resumeId)) {
            const fullPrompt = renderItems(input) || base.prompt;
            result = await invoke({ ...base, prompt: fullPrompt, sessionId: randomUUID(), resumeId: null,
              schema: buildSchema(tools, { loose: failure === 'schema' }) }, failure === 'schema' ? 'schema_fallback' : 'session_replay');
          }
        }
        if (result.ok && result.sessionId && isToolConfused(result.output) && canRetry()) {
          const nudge = await invoke({ ...base, sessionId: null, resumeId: result.sessionId, schema: buildSchema(tools),
            prompt: 'The tools work through your structured response only. Redo the pending step by placing the action in tool_calls; do not invoke a native tool or report it unavailable.' }, 'tool_correction');
          if (nudge.ok) result = nudge;
          else if (key) sessions.delete(key);
        }
        const usage = aggregateUsage(attempts);
        const knownCosts = attempts.map((a) => a.result.meta?.total_cost_usd);
        writeCost({ record_type: 'request', t: Date.now(), request_id: respId, key, attempt_count: attempts.length,
          ok: !!result.ok && !controller.signal.aborted, usage_complete: usage !== null,
          known_cost_usd: knownCosts.filter(Number.isFinite).reduce((a, b) => a + b, 0),
          cost_complete: knownCosts.every(Number.isFinite), cancelled: controller.signal.aborted });
        if (controller.signal.aborted || res.destroyed) {
          if (key) sessions.delete(key);
          if (!res.destroyed) stream.send('response.failed', { response: { ...responseBase, status: 'failed', output: [], usage,
            error: { code: 'bridge_cancelled', message: controller.signal.reason?.message || 'request cancelled' } } });
          return;
        }
        if (!result.ok) {
          if (key) sessions.delete(key);
          log('ERROR', result.error);
          stream.send('response.failed', { response: { ...responseBase, status: 'failed', output: [], usage,
            error: { code: 'bridge_error', message: result.error } } });
          return;
        }
        const items = toOutputItems(result.output, respId);
        if (key && CFG.mode !== 'stateless' && result.sessionId && attempts.every((a) => a.result.ok || a.reason !== 'tool_correction')) {
          sessions.set(key, { claudeSessionId: result.sessionId, forwarded: input.length,
            prefixFingerprint: fingerprint(input), contextFingerprint,
            knownOutputs: new Set(items.map(outputFingerprint).filter(Boolean)) });
        }
        const calls = items.filter((i) => i.type === 'function_call');
        log(`  -> ${calls.length} tool call(s)${calls.length ? ': ' + calls.map((c) => c.name).join(', ') : ' (turn complete)'}`);
        if (CFG.logDir) {
          try { fs.mkdirSync(CFG.logDir, { recursive: true });
            fs.writeFileSync(path.join(CFG.logDir, `${Date.now()}-${respId}.json`), JSON.stringify({ prompt: actualPrompt, output: result.output, items }, null, 2));
          } catch {}
        }
        emitItems(stream, items);
        stream.send('response.completed', { response: { ...responseBase, status: 'completed', output: items, usage } });
      } finally { clearInterval(heartbeat); if (!res.destroyed) stream.end(); }
    });
  } finally {
    clearTimeout(timeout);
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
  }
}

/* ────────────────────────────── server ────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode: CFG.mode, model: CFG.model || 'per-profile', effort: CFG.effort || 'per-profile', sessions: sessions.size, cache: 'off' }));
  }
  // Codex refreshes model metadata from GET /v1/models at startup. Its Model
  // struct is large, nested and version-specific, so serving a populated entry
  // means re-deriving it on every codex release — and a body it cannot decode
  // logs a noisier error than no body at all. An empty list parses cleanly:
  // codex falls back to default metadata (a harmless warning) with no error.
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', models: [], data: [] }));
  }
  if (req.method === 'POST' && url.endsWith('/responses')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      handleResponses(req, res, body).catch((e) => {
        log('unhandled', e);
        try { res.end(); } catch {}
      });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) server.listen(CFG.port, CFG.host, () => {
  if (process.env.BRIDGE_CACHE_DIR) log('BRIDGE_CACHE_DIR is ignored: unsafe response replay was removed; provider prefix caching remains enabled.');
  log(`listening on http://${CFG.host}:${CFG.port}/v1`);
  log(`claude=${CFG.claudeBin} model=${CFG.model || '(default)'} mode=${CFG.mode}`);
  log('point codex at it with:  base_url = "http://' + CFG.host + ':' + CFG.port + '/v1"');
});

export { CFG, server, sessions, handleResponses, runClaude, renderItems, planTurn, fingerprint, outputFingerprint, usageFrom, aggregateUsage, classifyFailure, resolveModel, isToolConfused, validateArguments, validateOutput };
