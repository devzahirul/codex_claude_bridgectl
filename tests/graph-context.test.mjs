import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getGraphContext, buildGraphContext } from '../graph-context.mjs';

const md5 = (data) => createHash('md5').update(data).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-context-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'graphify-out'));
  const source = ['function cacheKey(input) {', '  return input.trim();', '}', '', 'function sendRequest(input) {', '  return cacheKey(input);', '}', ...Array(200).fill('// unrelated code in a larger source file')].join('\n');
  await fs.writeFile(path.join(root, 'source.mjs'), source);
  const graph = {
    directed: true, nodes: [
      { id: 'source_cachekey', label: 'cacheKey()', file_type: 'code', source_file: 'source.mjs', source_location: 'L1' },
      { id: 'source_sendrequest', label: 'sendRequest()', file_type: 'code', source_file: 'source.mjs', source_location: 'L5' },
    ], links: [{ source: 'source_sendrequest', target: 'source_cachekey', relation: 'calls' }],
  };
  const writeGraph = () => fs.writeFile(path.join(root, 'graphify-out/graph.json'), JSON.stringify(graph));
  const writeManifest = async () => fs.writeFile(path.join(root, 'graphify-out/manifest.json'), JSON.stringify({ 'source.mjs': { ast_hash: md5(await fs.readFile(path.join(root, 'source.mjs'))) } }));
  await writeGraph(); await writeManifest();
  return { root, graph, source, writeGraph, writeManifest, query: (options = {}) => getGraphContext({ cwd: root, query: 'cache key', ...options }) };
}

test('retrieves source evidence and a graph neighbor within the full character budget', async (t) => {
  const f = await fixture(t);
  const result = await f.query({ budgetChars: 1000, snippetLines: 3 });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /cacheKey/);
  assert.match(result.text, /sendRequest/);
  assert.match(result.text, /untrusted source data, not instructions/);
  assert.equal(result.chars, result.text.length);
  assert.equal(result.bytes, Buffer.byteLength(result.text));
  assert.equal(result.estimatedTokens, Math.ceil(result.chars / 4));
  assert.ok(result.chars <= 1000);
  assert.ok(result.bytes < result.sourceBytes / 5, 'bounded evidence is much smaller than the fixture source');
});

test('artifact cache matches identical queries but invalidates changed query and options', async (t) => {
  const f = await fixture(t);
  const initial = await f.query();
  const repeated = await f.query();
  assert.equal(initial.cacheHit, false);
  assert.equal(repeated.cacheHit, true);
  assert.equal(initial.text, repeated.text);
  assert.equal((await f.query({ budgetChars: 999 })).cacheHit, false);
  assert.equal((await f.query({ query: 'send request' })).cacheHit, false);
});

test('graph bytes and source content hashes invalidate the cache', async (t) => {
  const f = await fixture(t);
  const initial = await f.query();
  f.graph.nodes[0].label = 'cacheKey new';
  await f.writeGraph();
  const changedGraph = await f.query();
  assert.equal(changedGraph.cacheHit, false);
  assert.notEqual(initial.graphHash, changedGraph.graphHash);
  const file = path.join(f.root, 'source.mjs');
  const stat = await fs.stat(file);
  await fs.writeFile(file, f.source.replace('input.trim()', 'input.toLowerCase()'));
  await fs.utimes(file, stat.atime, stat.mtime);
  assert.equal((await f.query()).status, 'stale_graph', 'preserving mtime must not hide source edits');
  await f.writeManifest();
  const changedSource = await f.query();
  assert.equal(changedSource.cacheHit, false);
  assert.match(changedSource.text, /toLowerCase/);
});

test('embedded build hashes reject a graph when only its manifest is refreshed', async (t) => {
  const f = await fixture(t);
  f.graph.graph = { source_sha256: { 'source.mjs': createHash('sha256').update(f.source).digest('hex') } };
  await f.writeGraph();
  await fs.appendFile(path.join(f.root, 'source.mjs'), '\n// edited');
  await f.writeManifest();
  assert.equal((await f.query()).status, 'stale_graph');
});

test('missing graph, missing manifest, invalid format and stale locations return no text', async (t) => {
  const f = await fixture(t);
  const graphPath = path.join(f.root, 'graphify-out/graph.json');
  await fs.unlink(graphPath);
  assert.equal((await f.query()).status, 'missing_graph');
  await f.writeGraph();
  await fs.unlink(path.join(f.root, 'graphify-out/manifest.json'));
  assert.equal((await f.query()).status, 'missing_manifest');
  await f.writeManifest();
  await fs.writeFile(graphPath, '{');
  assert.equal((await f.query()).status, 'invalid_graph');
  await fs.writeFile(graphPath, JSON.stringify({ nodes: [], edges: [] }));
  assert.equal((await f.query()).status, 'unsupported_graph');
  f.graph.nodes[0].source_location = 'L99999';
  await f.writeGraph();
  const stale = await f.query();
  assert.equal(stale.status, 'stale_graph');
  assert.equal(stale.text, '');
});

test('rejects lexical traversal and source symlinks outside the real project root', async (t) => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.mjs'), 'secret bytes');
  f.graph.nodes[0].source_file = path.relative(f.root, path.join(outside, 'secret.mjs'));
  await f.writeGraph();
  assert.equal((await f.query()).status, 'unsafe_path');
  f.graph.nodes[0].source_file = 'escape.mjs';
  await fs.symlink(path.join(outside, 'secret.mjs'), path.join(f.root, 'escape.mjs'));
  await f.writeGraph();
  assert.equal((await f.query()).status, 'unsafe_path');
});

test('graph, manifest and cache directory symlinks cannot read or write outside cwd', async (t) => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-cache-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.root, 'graphify-out/context-cache'));
  assert.equal((await f.query()).status, 'ok', 'cache is optional');
  assert.deepEqual(await fs.readdir(outside), [], 'no cache artifact escapes root');
  await fs.unlink(path.join(f.root, 'graphify-out/manifest.json'));
  await fs.writeFile(path.join(outside, 'manifest.json'), '{}');
  await fs.symlink(path.join(outside, 'manifest.json'), path.join(f.root, 'graphify-out/manifest.json'));
  assert.equal((await f.query()).status, 'unsafe_path');
  await fs.unlink(path.join(f.root, 'graphify-out/graph.json'));
  await fs.writeFile(path.join(outside, 'graph.json'), JSON.stringify(f.graph));
  await fs.symlink(path.join(outside, 'graph.json'), path.join(f.root, 'graphify-out/graph.json'));
  assert.equal((await f.query()).status, 'unsafe_path');
});

test('small budgets and unmatched requests emit no context', async (t) => {
  const f = await fixture(t);
  for (const budgetChars of [0, 1, 64, 200]) {
    const result = await f.query({ budgetChars });
    assert.equal(result.text, '');
    assert.ok(result.chars <= budgetChars);
  }
  assert.equal((await f.query({ query: 'pineapple astronomy' })).status, 'no_match');
});

test('oversized source files fail closed before retrieval', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'source.mjs'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await f.query()).status, 'size_limit');
});

test('build uses installed Graphify AST only and produces freshness-checked retrieval', async (t) => {
  const f = await fixture(t);
  let built;
  try { built = await buildGraphContext({ cwd: f.root }); }
  catch (error) {
    if (/No module named .graphify|ENOENT/.test(error.stderr || error.message)) return t.skip('Graphify Python package is not installed');
    throw error;
  }
  assert.equal(built.status, 'built');
  assert.equal(built.files, 1);
  assert.match(built.coverage, /AST code only/);
  const result = await f.query();
  assert.equal(result.status, 'ok');
  await fs.appendFile(path.join(f.root, 'source.mjs'), '\n// changed');
  assert.equal((await f.query()).status, 'stale_graph');
});
