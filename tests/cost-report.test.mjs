import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeCosts, summarizeCostFile, formatCostReport } from '../cost-report.mjs';

const attempt = (cost, extra = {}) => ({ record_type: 'attempt', reason: 'initial', model_resolved: 'sonnet', effort: 'low', cost_usd: cost,
  fresh_in: 10, cache_read: 80, cache_write: 10, out: 5, ...extra });
const jsonl = (records) => records.map(JSON.stringify).join('\n');

test('counts failed and recovery attempts without double-counting request totals', () => {
  const s = summarizeCosts(jsonl([attempt(0.03, { ok: false }), attempt(0.02, { reason: 'schema_fallback' }),
    { record_type: 'request', request_id: 'r', known_cost_usd: 0.05, ok: true }]));
  assert.equal(s.knownCostUsd, 0.05);
  assert.equal(s.attempts, 2);
  assert.equal(s.retries, 1);
  assert.equal(s.cacheReadShare, 0.8);
  assert.equal(s.requests, 1);
});

test('missing usage, malformed lines, and legacy logs remain explicitly incomplete', () => {
  const s = summarizeCosts(jsonl([attempt(null, { fresh_in: null }), { cost_usd: 7 }, null]) + '\n{broken');
  assert.equal(s.knownCostUsd, 0);
  assert.equal(s.unknownCostAttempts, 1);
  assert.equal(s.unknownUsageAttempts, 1);
  assert.equal(s.legacyRecords, 1);
  assert.equal(s.malformedLines, 2);
  assert.equal(s.costComplete, false);
  assert.equal(s.cacheReadShare, null);
  assert.match(formatCostReport(s), /partial; not a complete total/);
});

test('a request record with no request_id is counted, not silently dropped', () => {
  const s = summarizeCosts(jsonl([{ record_type: 'request', ok: false }, attempt(0.01)]));
  assert.equal(s.droppedRecords, 1);
  assert.equal(s.requests, 0);
  assert.equal(s.costComplete, false);
  assert.match(formatCostReport(s), /without a request_id could not be reconciled/);
});

test('a log appended to itself is de-duplicated instead of doubling the total', () => {
  const records = [attempt(0.01, { request_id: 'r', attempt: 1, reason: 'initial' }),
    attempt(0.02, { request_id: 'r', attempt: 2, reason: 'schema_fallback', ok: true }),
    { record_type: 'request', request_id: 'r', ok: true, attempt_count: 2, known_cost_usd: 0.03, cost_complete: true }];
  const once = summarizeCosts(jsonl(records));
  const twice = summarizeCosts(jsonl([...records, ...records]));
  assert.equal(once.knownCostUsd, 0.03);
  assert.equal(twice.knownCostUsd, once.knownCostUsd);
  assert.equal(twice.attempts, once.attempts);
  assert.equal(twice.duplicateAttempts, 2);
  assert.equal(twice.duplicateRequests, 1);
  assert.equal(once.costComplete, true);
});

test('a truncated log is reported as incomplete via the request record attempt_count', () => {
  const s = summarizeCosts(jsonl([attempt(0.02, { request_id: 'r', attempt: 3 }),
    { record_type: 'request', request_id: 'r', ok: true, attempt_count: 3, known_cost_usd: 0.06, cost_complete: true }]));
  assert.equal(s.missingAttempts, 2);
  assert.equal(s.costComplete, false);
  assert.match(formatCostReport(s), /log looks truncated/);
});

test('attempt costs that contradict the request record are flagged', () => {
  const s = summarizeCosts(jsonl([attempt(0.01, { request_id: 'r', attempt: 1 }),
    { record_type: 'request', request_id: 'r', ok: true, attempt_count: 1, known_cost_usd: 0.05, cost_complete: true }]));
  assert.equal(s.costMismatches, 1);
  assert.equal(s.missingAttempts, 0);
  assert.equal(s.costComplete, false);
});

test('float noise in a reconciliation is not a mismatch', () => {
  const s = summarizeCosts(jsonl([attempt(0.1, { request_id: 'r', attempt: 1 }), attempt(0.2, { request_id: 'r', attempt: 2 }),
    { record_type: 'request', request_id: 'r', ok: true, attempt_count: 2, known_cost_usd: 0.3, cost_complete: true }]));
  assert.equal(s.costMismatches, 0);
  assert.equal(s.costComplete, true);
});

test('table rows still add up to the total at sub-microdollar costs', () => {
  const s = summarizeCosts(jsonl([attempt(5e-7, { model_resolved: 'a' }), attempt(5e-7, { model_resolved: 'b' }), attempt(5e-7, { model_resolved: 'c' })]));
  const report = formatCostReport(s);
  const total = Number(report.match(/cost: \*\*\$([\d.]+)\*\*/)[1]);
  const rows = [...report.matchAll(/^\| \w \/ low \| 1 \| ([\d.]+) \|/gm)].map((m) => Number(m[1]));
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((a, b) => a + b, 0), total);
  assert.ok(total > 0, 'total must not round away to zero');
});

test('retries are separated from retries that recovered', () => {
  const s = summarizeCosts(jsonl([attempt(0.01, { ok: false }), attempt(0.01, { reason: 'retry', ok: false }), attempt(0.01, { reason: 'retry', ok: true })]));
  assert.equal(s.retries, 2);
  assert.equal(s.recoveries, 1);
  assert.match(formatCostReport(s), /retries: 2; retries that then succeeded: 1/);
});

test('failure cost is broken out by error type', () => {
  const s = summarizeCosts(jsonl([attempt(0.01, { ok: false, error_type: 'timeout' }), attempt(0.02, { ok: false, error_type: 'output' }),
    attempt(0.04, { ok: false, error_type: 'timeout' }), attempt(0.03, { ok: true })]));
  assert.equal(s.failedAttempts, 3);
  assert.ok(Math.abs(s.failedCostUsd - 0.07) < 1e-12);
  assert.deepEqual(s.byErrorType.map((e) => e.type), ['timeout', 'output']);
  assert.equal(s.byErrorType[0].attempts, 2);
  assert.match(formatCostReport(s), /\| timeout \| 2 \|/);
});

test('cancelled requests are counted apart from failed ones', () => {
  const s = summarizeCosts(jsonl([{ record_type: 'request', request_id: 'a', ok: false, cancelled: true },
    { record_type: 'request', request_id: 'b', ok: false, cancelled: false }, { record_type: 'request', request_id: 'c', ok: true }]));
  assert.equal(s.requests, 3);
  assert.equal(s.cancelledRequests, 1);
  assert.equal(s.failedRequests, 1);
  assert.match(formatCostReport(s), /failed: 1; cancelled: 1/);
});

test('a record_type from a newer bridge is not reported as legacy data loss', () => {
  const s = summarizeCosts(jsonl([{ record_type: 'session', request_id: 'r' }, { cost_usd: 7 }, [1, 2, 3]]));
  assert.equal(s.unknownRecords, 1);
  assert.equal(s.legacyRecords, 1);
  assert.equal(s.malformedLines, 1, 'a JSON array is malformed, not a legacy record');
  assert.match(formatCostReport(s), /older than the bridge that wrote/);
});

test('a clean log reports no integrity warnings', () => {
  const s = summarizeCosts(jsonl([attempt(0.01, { request_id: 'r', attempt: 1, ok: true }),
    { record_type: 'request', request_id: 'r', ok: true, attempt_count: 1, known_cost_usd: 0.01, cost_complete: true }]));
  assert.equal(s.costComplete, true);
  const report = formatCostReport(s);
  assert.doesNotMatch(report, /Log integrity/);
  assert.doesNotMatch(report, /partial; not a complete total/);
});

test('streaming a file matches summarizing its text, CRLF included', async () => {
  const records = [attempt(0.01, { request_id: 'r', attempt: 1 }), { record_type: 'request', request_id: 'r', ok: true, attempt_count: 1 }];
  const path = join(tmpdir(), `cost-report-test-${process.pid}.jsonl`);
  await fs.writeFile(path, records.map((r) => JSON.stringify(r)).join('\r\n') + '\r\n');
  try {
    assert.deepEqual(await summarizeCostFile(path), summarizeCosts(jsonl(records)));
  } finally { await fs.rm(path, { force: true }); }
});
