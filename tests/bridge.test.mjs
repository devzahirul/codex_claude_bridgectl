import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CFG, sessions, handleResponses, runClaude, renderItems, fingerprint, outputFingerprint,
  planTurn, usageFrom, aggregateUsage, classifyFailure, resolveModel, isToolConfused, validateArguments } from '../bridge.mjs';

const original = { ...CFG };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-test-'));
const originalCostLog = process.env.BRIDGE_COST_LOG;
const costLog = path.join(directory, 'cost.jsonl');
const initial = [{ id: 'user-1', type: 'message', role: 'user', content: 'Original task: inspect this project' }];
const tool = { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } };
const payload = (extra = {}) => ({ input: initial, tools: [tool], model: 'claude-sonnet-5', prompt_cache_key: 'thread', ...extra });
const success = (extra = {}) => ({ ok: true, output: { message: 'Done', tool_calls: [] }, sessionId: 'claude-session',
  meta: { total_cost_usd: 0.02, usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 } } }, ...extra });
function response() {
  const res = new EventEmitter();
  Object.assign(res, { chunks: [], destroyed: false, writableEnded: false,
    writeHead(status) { this.statusCode = status; }, write(chunk) { this.chunks.push(chunk); },
    end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; } });
  return res;
}
function events(res) { return res.chunks.join('').split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))); }
const terminal = (res) => events(res).findLast((event) => ['response.completed', 'response.failed'].includes(event.type));
async function request(data, runner) {
  const req = new EventEmitter(), res = response();
  await handleResponses(req, res, JSON.stringify(data), { runner });
  return res;
}
const records = () => fs.readFileSync(costLog, 'utf8').trim().split('\n').map(JSON.parse);

beforeEach(() => {
  Object.assign(CFG, original, { model: '', effort: '', mode: 'session', maxAttempts: 2, requestTimeoutMs: 10000, timeoutMs: 10000, logDir: '' });
  sessions.clear();
  process.env.BRIDGE_COST_LOG = costLog;
  fs.writeFileSync(costLog, '');
});
after(() => {
  Object.assign(CFG, original);
  if (originalCostLog === undefined) delete process.env.BRIDGE_COST_LOG; else process.env.BRIDGE_COST_LOG = originalCostLog;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('usage distinguishes missing metadata from real zero and aggregates attempts', () => {
  assert.equal(usageFrom(null), null);
  assert.equal(usageFrom({ usage: {} }), null);
  const sum = aggregateUsage([{ result: success() }, { result: success() }]);
  assert.equal(sum.input_tokens, 560);
  assert.equal(sum.output_tokens, 40);
  assert.equal(sum.input_tokens_details.cached_tokens, 100);
  assert.equal(aggregateUsage([{ result: success() }, { result: { ok: false } }]), null);
  assert.equal(usageFrom({ usage: { input_tokens: 0, output_tokens: 0 } }).total_tokens, 0);
});

test('unknown non-Claude models fail before any subprocess call; override remains explicit', async () => {
  assert.equal(resolveModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.throws(() => resolveModel('gpt-5.5'), /Unsupported bridge model/);
  const res = await request(payload({ model: 'gpt-5.5' }), () => assert.fail('must not call model'));
  assert.equal(res.statusCode, 400);
  CFG.model = 'sonnet';
  assert.equal(resolveModel('gpt-5.5'), 'sonnet');
});

test('history checks actual full prefix and model/schema/cwd context', () => {
  sessions.set('thread', { claudeSessionId: 's', forwarded: initial.length,
    prefixFingerprint: fingerprint(initial), contextFingerprint: 'context', knownOutputs: new Set() });
  assert.equal(planTurn('thread', [...initial, { type: 'message', role: 'user', content: 'next' }], 'context').resumeId, 's');
  assert.equal(planTurn('thread', [{ ...initial[0], content: 'different task, same ID' }], 'context').resumeId, null);
  assert.equal(planTurn('thread', initial, 'different schema').resumeId, null);
  assert.equal(planTurn(null, initial, 'context').resumeId, null);
});

test('unkeyed requests never share an implicit default session', async () => {
  const args = [];
  for (let i = 0; i < 2; i++) await request(payload({ prompt_cache_key: undefined }), async (a) => { args.push(a); return success(); });
  assert.equal(args[0].resumeId, null);
  assert.equal(args[1].resumeId, null);
  assert.equal(sessions.size, 0);
});

test('only proven bridge outputs are omitted from resumed transcript', async () => {
  const first = await request(payload(), async () => success({ output: { message: 'I will inspect the project.', tool_calls: [{ name: 'exec_command', arguments: { cmd: 'pwd' } }] } }));
  const emitted = terminal(first).response.output;
  const nextInput = [...initial, ...emitted, { type: 'function_call_output', call_id: emitted[1].call_id, output: '/project' },
    { type: 'message', id: 'external', role: 'assistant', content: 'External assistant update' }];
  let sent;
  await request(payload({ input: nextInput }), async (args) => { sent = args; return success(); });
  assert.equal(sent.resumeId, 'claude-session');
  assert.doesNotMatch(sent.prompt, /I will inspect the project|assistant_tool_call/);
  assert.match(sent.prompt, /\/project|External assistant update/);
  const altered = { ...emitted[0], content: [{ type: 'output_text', text: 'Edited assistant text' }] };
  const rendered = renderItems([altered], { knownOutputs: new Set([outputFingerprint(emitted[0])]) });
  assert.match(rendered, /Edited assistant text/);
});

test('schema retry starts fresh with full history and accounts both attempts', async () => {
  await request(payload(), async () => success());
  fs.writeFileSync(costLog, '');
  const args = [];
  const failed = { ok: false, error: 'schema validation rejected', meta: { total_cost_usd: 0.03, usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  const res = await request(payload({ input: [...initial, { type: 'function_call_output', call_id: 'c', output: 'new output' }] }), async (a) => {
    args.push(a); return args.length === 1 ? failed : success();
  });
  assert.equal(args[0].resumeId, 'claude-session');
  assert.doesNotMatch(args[0].prompt, /Original task/);
  assert.equal(args[1].resumeId, null);
  assert.ok(args[1].sessionId);
  assert.match(args[1].prompt, /Original task/);
  assert.match(args[1].prompt, /new output/);
  const logged = records(), attempts = logged.filter((r) => r.record_type === 'attempt');
  assert.equal(attempts.length, 2);
  assert.equal(attempts.reduce((sum, a) => sum + a.cost_usd, 0), 0.05);
  assert.equal(attempts[1].cache_write_5m, 20);
  assert.equal(attempts[1].cache_write_1h, 10);
  assert.equal(logged.at(-1).known_cost_usd, 0.05);
  assert.equal(logged.at(-1).cost_usd, undefined);
  assert.equal(terminal(res).response.usage.total_tokens, 660);
});

test('provider errors are not retried merely because a session was resumed', async () => {
  await request(payload(), async () => success());
  let calls = 0;
  const res = await request(payload({ input: [...initial, { type: 'message', role: 'user', content: 'next' }] }), async () => {
    calls++; return { ok: false, error: 'rate limit exceeded' };
  });
  assert.equal(calls, 1);
  assert.equal(terminal(res).type, 'response.failed');
  assert.equal(terminal(res).response.usage, null);
  assert.equal(records().at(-2).cost_usd, null);
  assert.equal(records().at(-2).fresh_in, null);
});

test('stale session retry replays all context and stays within request attempt cap', async () => {
  await request(payload(), async () => success());
  const args = [];
  const res = await request(payload({ input: [...initial, { type: 'message', role: 'user', content: 'next' }] }), async (a) => {
    args.push(a); return args.length === 1 ? { ok: false, error: 'session abc not found' } : success({ output: { message: 'tool unavailable', tool_calls: [] } });
  });
  assert.equal(args.length, 2);
  assert.equal(args[1].resumeId, null);
  assert.match(args[1].prompt, /Original task/);
  assert.equal(terminal(res).response.usage, null);
});

test('one-attempt limit prevents schema fallback and correction attempts', async () => {
  CFG.maxAttempts = 1;
  let calls = 0;
  await request(payload(), async () => { calls++; return { ok: false, error: 'invalid schema' }; });
  assert.equal(calls, 1);
  await request(payload(), async () => { calls++; return success({ output: { message: 'tool unavailable', tool_calls: [] } }); });
  assert.equal(calls, 2);
});

test('tool correction failure is charged and invalidates the uncertain session', async () => {
  let calls = 0;
  const res = await request(payload(), async () => ++calls === 1 ? success({ output: { message: 'tool is not available', tool_calls: [] } }) : { ok: false, error: 'service unavailable', meta: success().meta });
  assert.equal(calls, 2);
  assert.equal(sessions.has('thread'), false);
  assert.equal(terminal(res).response.usage.total_tokens, 600);
  assert.equal(records().filter((r) => r.record_type === 'attempt').length, 2);
});

test('same-thread concurrent requests serialize and use updated session state', async () => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const args = [];
  const runner = async (a) => { args.push(a); if (args.length === 1) { started(); await gate; } return success(); };
  const first = request(payload(), runner);
  await entered;
  const second = request(payload({ input: [...initial, { type: 'message', role: 'user', content: 'next' }] }), runner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(args.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(args.length, 2);
  assert.equal(args[1].resumeId, 'claude-session');
});

test('client disconnect aborts invocation, logs unknown cost, and drops session', async () => {
  const req = new EventEmitter(), res = response();
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const promise = handleResponses(req, res, JSON.stringify(payload()), { runner: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ok: false, error: 'request cancelled', errorType: 'cancelled' }), { once: true }); started();
  }) });
  await entered;
  res.destroyed = true;
  res.emit('close');
  await promise;
  assert.equal(terminal(res), undefined);
  assert.equal(sessions.size, 0);
  assert.equal(records().at(-1).cancelled, true);
  assert.equal(records().at(-2).cost_usd, null);
});

test('overall request deadline sends a terminal failure to connected client', async () => {
  CFG.requestTimeoutMs = 20;
  const res = await request(payload(), ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ok: false, error: 'request cancelled', errorType: 'cancelled' }), { once: true });
  }));
  assert.equal(terminal(res).type, 'response.failed');
  assert.match(terminal(res).response.error.message, /deadline/);
  assert.equal(res.writableEnded, true);
});

test('local tool validation prevents unsupported names or incorrect loose-schema arguments', async () => {
  const badCalls = [{ name: 'unknown', arguments: {} }, { name: 'exec_command', arguments: { command: 'pwd' } }, { name: 'exec_command', arguments: { cmd: 123 } }];
  for (const call of badCalls) {
    const res = await request(payload(), async () => success({ output: { message: '', tool_calls: [call] } }));
    assert.equal(terminal(res).type, 'response.failed');
    assert.equal(events(res).some((e) => e.type === 'response.function_call_arguments.done'), false);
  }
  assert.equal(validateArguments({ cmd: 'pwd' }, tool.parameters), null);
  assert.match(validateArguments({ cmd: 'pwd', extra: true }, tool.parameters), /not allowed/);
  assert.match(validateArguments('a', { type: 'string', minLength: 2 }), /length/);
  assert.match(validateArguments(3, { type: 'number', maximum: 2 }), /range/);
  assert.match(validateArguments({}, { $ref: '#/other' }), /unsupported/);
});

test('tool confusion matcher handles common unavailable messages', () => {
  for (const message of ['No such tool available', 'tool unavailable', 'tool is not available']) assert.equal(isToolConfused({ message, tool_calls: [] }), true);
  assert.equal(isToolConfused({ message: 'tool unavailable', tool_calls: [{}] }), false);
  assert.equal(classifyFailure({ error: 'session expired' }), 'session');
  assert.equal(classifyFailure({ error: 'authentication failed for session' }), 'provider');
});

test('actual subprocess cancellation kills a bounded local mock process', async () => {
  const fake = path.join(directory, 'fake-claude.mjs'), marker = path.join(directory, 'mock.pid');
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  CFG.claudeBin = fake;
  const controller = new AbortController();
  const running = runClaude({ systemPrompt: 'test', prompt: 'test', schema: {}, signal: controller.signal, timeoutMs: 3000 });
  const end = Date.now() + 2000;
  while (!fs.existsSync(marker) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(marker), 'mock process started');
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  controller.abort();
  assert.equal((await running).errorType, 'cancelled');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('mock child still running after abort');
});
