#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node cost-report.mjs PATH.jsonl [--json]';
const USAGE_FIELDS = [['fresh_in', 'freshInput'], ['cache_read', 'cacheRead'], ['cache_write', 'cacheWrite'], ['out', 'output']];
/** Costs are dollars; compare reconciliations with a tolerance rather than exact float equality. */
const closeEnough = (a, b) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.abs(b);

/**
 * Line-at-a-time accumulator, so a cost log that only ever grows can be summarized as a stream.
 * Sums attempt records only: a request record repeats its own attempts' costs in `known_cost_usd`,
 * and is used here to reconcile the attempts rather than to add to the total.
 */
export function createCostSummarizer() {
  const summary = { attempts: 0, requests: 0, failedRequests: 0, cancelledRequests: 0, retries: 0, recoveries: 0,
    failedAttempts: 0, failedCostUsd: 0, knownCostUsd: 0, unknownCostAttempts: 0,
    malformedLines: 0, legacyRecords: 0, unknownRecords: 0, droppedRecords: 0,
    duplicateAttempts: 0, duplicateRequests: 0, missingAttempts: 0, costMismatches: 0,
    freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, unknownUsageAttempts: 0,
    byModelEffort: [], byErrorType: [] };
  const groups = new Map();
  const errorTypes = new Map();
  const requests = new Map();  // request_id -> last request record seen
  const observed = new Map();  // request_id -> the attempts actually found in this log
  const track = (id) => {
    const seen = observed.get(id) || { attempts: 0, costUsd: 0, costComplete: true, numbers: new Set() };
    observed.set(id, seen);
    return seen;
  };

  const addRequest = (record) => {
    // A request record with no id cannot be reconciled or de-duplicated; count it rather than drop it silently.
    if (typeof record.request_id !== 'string') { summary.droppedRecords++; return; }
    if (requests.has(record.request_id)) summary.duplicateRequests++;
    requests.set(record.request_id, record);
  };

  const addAttempt = (record) => {
    // (request_id, attempt) is unique per turn, so a log appended or merged twice repeats keys we have seen.
    const id = typeof record.request_id === 'string' ? record.request_id : null;
    const seen = id === null ? null : track(id);
    if (seen && Number.isFinite(record.attempt)) {
      if (seen.numbers.has(record.attempt)) { summary.duplicateAttempts++; return; }
      seen.numbers.add(record.attempt);
    }
    summary.attempts++;
    const cost = Number.isFinite(record.cost_usd) && record.cost_usd >= 0 ? record.cost_usd : null;

    const name = `${record.model_resolved || '(default)'} / ${record.effort || '(default)'}`;
    const group = groups.get(name) || { name, attempts: 0, knownCostUsd: 0, unknownCostAttempts: 0 };
    group.attempts++;
    if (cost !== null) { summary.knownCostUsd += cost; group.knownCostUsd += cost; }
    else { summary.unknownCostAttempts++; group.unknownCostAttempts++; }
    groups.set(name, group);

    if (record.reason !== 'initial') { summary.retries++; if (record.ok === true) summary.recoveries++; }
    if (record.ok === false) {
      summary.failedAttempts++;
      if (cost !== null) summary.failedCostUsd += cost;
      const type = typeof record.error_type === 'string' && record.error_type ? record.error_type : '(unclassified)';
      const bucket = errorTypes.get(type) || { type, attempts: 0, knownCostUsd: 0 };
      bucket.attempts++;
      if (cost !== null) bucket.knownCostUsd += cost;
      errorTypes.set(type, bucket);
    }

    let complete = true;
    for (const [field, total] of USAGE_FIELDS) {
      if (Number.isFinite(record[field]) && record[field] >= 0) summary[total] += record[field];
      else complete = false;
    }
    if (!complete) summary.unknownUsageAttempts++;

    if (seen) {
      seen.attempts++;
      if (cost !== null) seen.costUsd += cost; else seen.costComplete = false;
    }
  };

  return {
    add(line) {
      if (!line.trim()) return;
      let record;
      try { record = JSON.parse(line); } catch { summary.malformedLines++; return; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) { summary.malformedLines++; return; }
      if (record.record_type === 'request') addRequest(record);
      else if (record.record_type === 'attempt') addAttempt(record);
      else if (record.record_type === undefined || record.record_type === null) summary.legacyRecords++;
      else summary.unknownRecords++;  // written by a newer bridge than this script knows about
    },
    finish() {
      summary.requests = requests.size;
      for (const [id, record] of requests) {
        const seen = observed.get(id) || { attempts: 0, costUsd: 0, costComplete: true };  // no attempts survived for this request
        if (record.cancelled === true) summary.cancelledRequests++;
        else if (!record.ok) summary.failedRequests++;
        // The request record knows how many attempts it wrote; fewer here means the log lost its head.
        if (Number.isFinite(record.attempt_count) && record.attempt_count > seen.attempts) summary.missingAttempts += record.attempt_count - seen.attempts;
        if (seen.costComplete && record.cost_complete === true && Number.isFinite(record.known_cost_usd)
          && !closeEnough(seen.costUsd, record.known_cost_usd)) summary.costMismatches++;
      }
      summary.byModelEffort = [...groups.values()].sort((a, b) => b.knownCostUsd - a.knownCostUsd || a.name.localeCompare(b.name));
      summary.byErrorType = [...errorTypes.values()].sort((a, b) => b.knownCostUsd - a.knownCostUsd || b.attempts - a.attempts);
      summary.costComplete = summary.unknownCostAttempts === 0 && summary.legacyRecords === 0 && summary.unknownRecords === 0
        && summary.malformedLines === 0 && summary.droppedRecords === 0 && summary.missingAttempts === 0 && summary.costMismatches === 0;
      const input = summary.freshInput + summary.cacheRead + summary.cacheWrite;
      summary.cacheReadShare = summary.unknownUsageAttempts === 0 && input ? summary.cacheRead / input : null;
      return summary;
    },
  };
}

export function summarizeCosts(jsonl) {
  const summarizer = createCostSummarizer();
  for (const line of jsonl.split('\n')) summarizer.add(line);
  return summarizer.finish();
}

/** Streams the file so memory does not scale with the log. */
export async function summarizeCostFile(path) {
  const summarizer = createCostSummarizer();
  const lines = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) summarizer.add(line);
  return summarizer.finish();
}

/** One decimal count for every dollar figure in a report, wide enough that the rows still add up to the total. */
export function costDecimals(values) {
  let decimals = 6;
  for (const value of values) {
    if (!Number.isFinite(value) || value === 0) continue;
    decimals = Math.max(decimals, Math.min(12, Math.ceil(-Math.log10(Math.abs(value))) + 2));
  }
  return decimals;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cell = (text) => String(text).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');

export function formatCostReport(s) {
  const dec = costDecimals([s.knownCostUsd, s.failedCostUsd, ...s.byModelEffort.map((g) => g.knownCostUsd), ...s.byErrorType.map((e) => e.knownCostUsd)]);
  const usd = (value) => value.toFixed(dec);
  const lines = ['# Bridge cost report', '',
    `Known API-equivalent cost: **$${usd(s.knownCostUsd)}**${s.costComplete ? '' : ' (partial; not a complete total)'}.`,
    'This uses Claude-reported estimates, not subscription allowance or invoice data.', '',
    `Attempts: ${s.attempts}, of which ${s.failedAttempts} failed costing $${usd(s.failedCostUsd)}; retries: ${s.retries}; retries that then succeeded: ${s.recoveries}.`,
    `Completed request records: ${s.requests}; failed: ${s.failedRequests}; cancelled: ${s.cancelledRequests}.`,
    `Unknown-cost attempts: ${s.unknownCostAttempts}; unknown-usage attempts: ${s.unknownUsageAttempts}.`];

  const warnings = [];
  if (s.duplicateAttempts) warnings.push(`${plural(s.duplicateAttempts, 'repeated attempt record', 'repeated attempt records')} ignored — the log looks appended or merged twice.`);
  if (s.duplicateRequests) warnings.push(`${plural(s.duplicateRequests, 'repeated request record', 'repeated request records')}; only the last of each was used.`);
  if (s.missingAttempts) warnings.push(`${plural(s.missingAttempts, 'attempt record', 'attempt records')} the request records say should exist ${s.missingAttempts === 1 ? 'is' : 'are'} absent — the log looks truncated, so the total is too low.`);
  if (s.costMismatches) warnings.push(`${plural(s.costMismatches, 'request whose attempt costs disagree', 'requests whose attempt costs disagree')} with the request record's own total.`);
  if (s.droppedRecords) warnings.push(`${plural(s.droppedRecords, 'request record', 'request records')} without a request_id could not be reconciled.`);
  if (s.unknownRecords) warnings.push(`${plural(s.unknownRecords, 'record', 'records')} of a type this script does not know — it is older than the bridge that wrote ${s.unknownRecords === 1 ? 'it' : 'them'}.`);
  if (s.legacyRecords) warnings.push(`${plural(s.legacyRecords, 'legacy record', 'legacy records')} with no record_type ${s.legacyRecords === 1 ? 'was' : 'were'} skipped.`);
  if (s.malformedLines) warnings.push(`${plural(s.malformedLines, 'malformed line', 'malformed lines')} ${s.malformedLines === 1 ? 'was' : 'were'} skipped.`);
  if (warnings.length) lines.push('', '**Log integrity**', ...warnings.map((w) => `- ${w}`));

  lines.push('', '| Model / effort | Attempts | Known cost (USD) | Unknown-cost attempts |', '|---|---:|---:|---:|');
  for (const g of s.byModelEffort) lines.push(`| ${cell(g.name)} | ${g.attempts} | ${usd(g.knownCostUsd)} | ${g.unknownCostAttempts} |`);

  if (s.byErrorType.length) {
    lines.push('', '| Failure type | Attempts | Known cost (USD) |', '|---|---:|---:|');
    for (const e of s.byErrorType) lines.push(`| ${cell(e.type)} | ${e.attempts} | ${usd(e.knownCostUsd)} |`);
  }

  lines.push('', `Known tokens: ${s.freshInput} fresh input; ${s.cacheRead} cache reads; ${s.cacheWrite} cache writes; ${s.output} output.`);
  if (s.cacheReadShare !== null) lines.push(`Cache-read share of reported input: ${(s.cacheReadShare * 100).toFixed(1)}%.`);
  lines.push('', 'Request summary rows are excluded from cost sums to avoid counting attempts twice. Request success is not task correctness; measure accepted task outcomes separately.');
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const files = args.filter((a) => !a.startsWith('-'));
    const flags = args.filter((a) => a.startsWith('-'));
    if (files.length !== 1 || flags.some((f) => f !== '--json')) throw new Error(USAGE);
    const summary = await summarizeCostFile(files[0]);
    process.stdout.write(flags.includes('--json') ? JSON.stringify(summary, null, 2) + '\n' : formatCostReport(summary));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
