import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGECTL = join(ROOT, 'bridgectl');
const hasCodex = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

// A config shaped like a real one: root keys first, then tables we must not disturb.
const CONFIG = `model = "gpt-6-astra"

plan_mode_reasoning_effort = "xhigh"
model_reasoning_effort = "ultra"

[projects."/tmp/x"]
trust_level = "trusted"

[tui.model_availability_nux]
gpt-6-astra = 4
`;

const run = (home, state, ...args) =>
  execFileSync(BRIDGECTL, ['--codex-home', home, '--state-dir', state, ...args], { encoding: 'utf8' });

test('setup --global and use-codex round-trip a config byte for byte', { skip: hasCodex ? false : 'codex CLI not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridgectl-'));
  const home = join(dir, 'codex');
  const state = join(dir, 'state');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  const config = join(home, 'config.toml');
  await fs.writeFile(config, CONFIG);
  try {
    // Toggling repeatedly must not accumulate blank lines or lose user settings.
    for (let cycle = 0; cycle < 3; cycle++) {
      run(home, state, 'setup', '--global');
      const active = await fs.readFile(config, 'utf8');
      assert.match(active, /^model = "claude-sonnet-5"$/m, `cycle ${cycle}: bridge model not active`);
      assert.match(active, /^model_provider = "claudebridge"$/m);
      assert.match(active, /#codex-claude-bridge-disabled# model = "gpt-6-astra"/, 'previous root model must be preserved for restore');
      assert.match(active, /\[projects\."\/tmp\/x"\]/, 'unrelated tables must survive');

      run(home, state, 'use-codex');
      assert.equal(await fs.readFile(config, 'utf8'), CONFIG, `cycle ${cycle}: config did not return to its original bytes`);
    }
    const catalog = JSON.parse(await fs.readFile(join(home, 'claude.models.json'), 'utf8'));
    assert.ok(catalog.models.length > 0, 'setup must write a populated Claude catalog');
    const profile = await fs.readFile(join(home, 'claude.config.toml'), 'utf8');
    assert.match(profile, /^model_catalog_json = /m, 'profiles must point codex at the catalog');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('use-codex is a no-op when the bridge was never installed globally', { skip: hasCodex ? false : 'codex CLI not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridgectl-'));
  const home = join(dir, 'codex');
  const state = join(dir, 'state');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  const config = join(home, 'config.toml');
  await fs.writeFile(config, CONFIG);
  try {
    const out = run(home, state, 'use-codex');
    assert.match(out, /already on your own settings/);
    assert.equal(await fs.readFile(config, 'utf8'), CONFIG);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
