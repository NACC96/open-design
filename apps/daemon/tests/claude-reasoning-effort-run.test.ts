// Claude reasoning effort, end to end through `POST /api/runs`.
//
// Covers three review findings on the Claude model picker:
//
// 1. A run with no selected model (`model: null`) used to drop the effort:
//    effort options lived only on the `default` model entry, so validation
//    against a null model found nothing and `--effort` never reached Claude.
// 2. An inconclusive `--help` probe (timeout / failure, cached as `{}`) used to
//    let `--effort` through, and an older CLI then aborted the run on an
//    unknown option. The run now re-probes once and, when support is still
//    unconfirmed, omits the effort and says so with a run diagnostic.
// 3. `od run start --reasoning <level>` succeeded silently when the level was
//    dropped. The create response now reports the resolved level, and the CLI
//    warns on stderr when it was not applied.
import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const execFileP = promisify(execFile);
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type HelpMode = 'advertised' | 'unadvertised' | 'failing';
type FakeClaude = { bin: string; argvLog: string };
type RunCreateBody = {
  runId: string;
  reasoning?: { requested: string; applied: string | null; options: string[] };
};

describe('Claude reasoning effort through POST /api/runs', () => {
  let started: StartedServer | null = null;
  let binDir: string | null = null;

  afterEach(async () => {
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    started = null;
    if (binDir) await rm(binDir, { recursive: true, force: true });
    binDir = null;
  });

  async function setup(mode: HelpMode): Promise<FakeClaude> {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-claude-effort-'));
    const fake = await writeFakeClaude(binDir, mode);
    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    await putConfig(started.url, {
      agentId: 'claude',
      agentModels: {},
      agentCliEnv: { claude: { CLAUDE_BIN: fake.bin } },
      telemetry: { metrics: false, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
      odNextStrategyMode: 'off',
    });
    return fake;
  }

  it('forwards the effort when no model is selected (model: null)', async () => {
    const fake = await setup('advertised');
    const { created, status } = await createAndWaitForRun(started!.url, {
      model: null,
      reasoning: 'max',
    });

    expect(status.status).toBe('succeeded');
    expect(created.reasoning).toMatchObject({ requested: 'max', applied: 'max' });
    expect(created.reasoning?.options).toContain('xhigh');
    const args = await runArgv(fake);
    expect(args).not.toContain('--model');
    expect(effortArg(args)).toBe('max');
  });

  it('drops the effort for a legacy model that takes none, and reports it', async () => {
    const fake = await setup('advertised');
    const { created, status } = await createAndWaitForRun(started!.url, {
      model: 'claude-haiku-4-5',
      reasoning: 'max',
    });

    expect(status.status).toBe('succeeded');
    expect(created.reasoning).toEqual({ requested: 'max', applied: null, options: [] });
    expect(await runArgv(fake)).not.toContain('--effort');
  });

  it('re-probes once, then omits the effort with a diagnostic when support stays unknown', async () => {
    const fake = await setup('failing');
    const { created, status } = await createAndWaitForRun(started!.url, {
      model: 'claude-sonnet-5-5',
      reasoning: 'high',
    });

    // The run must not abort because the probe could not answer.
    expect(status.status).toBe('succeeded');
    expect(created.reasoning).toMatchObject({ requested: 'high', applied: 'high' });
    expect(await runArgv(fake)).not.toContain('--effort');
    expect(await helpProbeCount(fake)).toBe(2);
    const diagnostic = await findDiagnostic(started!.url, created.runId, 'reasoning_effort_omitted');
    expect(diagnostic).toMatchObject({
      agentId: 'claude',
      requested: 'high',
      flag: '--effort',
      reason: 'unknown',
    });
  });

  it('omits the effort with a diagnostic when the CLI does not advertise --effort', async () => {
    const fake = await setup('unadvertised');
    const { created, status } = await createAndWaitForRun(started!.url, {
      model: 'claude-sonnet-5-5',
      reasoning: 'high',
    });

    expect(status.status).toBe('succeeded');
    expect(await runArgv(fake)).not.toContain('--effort');
    // An explicit answer needs no re-probe.
    expect(await helpProbeCount(fake)).toBe(1);
    const diagnostic = await findDiagnostic(started!.url, created.runId, 'reasoning_effort_omitted');
    expect(diagnostic).toMatchObject({ requested: 'high', reason: 'unsupported' });
  });

  it('warns from `od run start` when the requested level is not applied', async () => {
    await setup('advertised');
    const projectId = await createProject(started!.url);
    const result = await runCli([
      'run', 'start', '--project', projectId,
      '--agent', 'claude', '--model', 'claude-sonnet-4-6', '--reasoning', 'xhigh',
      '--message', 'build a prototype',
      '--daemon-url', started!.url, '--json',
    ]);

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as RunCreateBody;
    expect(output.reasoning).toEqual({
      requested: 'xhigh',
      applied: null,
      options: ['default', 'low', 'medium', 'high', 'max'],
    });
    expect(result.stderr).toContain('--reasoning xhigh was not applied');
    expect(result.stderr).toContain('default, low, medium, high, max');
    await waitForRun(started!.url, output.runId);
  });

  it('stays quiet from `od run start` when the requested level is applied', async () => {
    await setup('advertised');
    const projectId = await createProject(started!.url);
    const result = await runCli([
      'run', 'start', '--project', projectId,
      '--agent', 'claude', '--reasoning', 'medium',
      '--message', 'build a prototype',
      '--daemon-url', started!.url, '--json',
    ]);

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as RunCreateBody;
    expect(output.reasoning).toMatchObject({ requested: 'medium', applied: 'medium' });
    expect(result.stderr).not.toContain('was not applied');
    await waitForRun(started!.url, output.runId);
  });
});

async function writeFakeClaude(dir: string, mode: HelpMode): Promise<FakeClaude> {
  const bin = path.join(dir, `claude-${mode}`);
  const argvLog = path.join(dir, 'argv.log');
  const effortHelp = mode === 'advertised' ? ' [--effort <level>]' : '';
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('2.1.299 (Claude Code)'); process.exit(0); }
if (args.includes('--help')) {
  if (${JSON.stringify(mode)} === 'failing') { console.error('help unavailable'); process.exit(1); }
  console.log('Usage: claude -p [--include-partial-messages] [--add-dir DIR]${effortHelp}');
  process.exit(0);
}
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (!args.includes('--output-format')) { console.error("error: unknown option '" + args[1] + "'"); process.exit(1); }
const W = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n');
W({ type: 'system', subtype: 'init', model: 'effort-test' });
W({ type: 'assistant', message: { id: 'm_done', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } });
process.exit(0);
`, 'utf8');
  await chmod(bin, 0o755);
  return { bin, argvLog };
}

async function invocations(fake: FakeClaude): Promise<string[][]> {
  const raw = await readFile(fake.argvLog, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

async function runArgv(fake: FakeClaude): Promise<string[]> {
  const runs = (await invocations(fake)).filter((args) => args.includes('--output-format'));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

async function helpProbeCount(fake: FakeClaude): Promise<number> {
  return (await invocations(fake)).filter((args) => args.includes('--help')).length;
}

function effortArg(args: string[]): string | null {
  const index = args.indexOf('--effort');
  return index === -1 ? null : args[index + 1] ?? null;
}

async function putConfig(url: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${url}/api/app-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
}

async function createProject(url: string): Promise<string> {
  const projectId = `claude_effort_${randomUUID()}`;
  const response = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectId,
      name: 'Claude reasoning effort',
      metadata: { kind: 'prototype' },
      skipDiscoveryBrief: true,
    }),
  });
  expect(response.status).toBe(200);
  return projectId;
}

async function createAndWaitForRun(
  url: string,
  selection: { model: string | null; reasoning: string },
): Promise<{ created: RunCreateBody; status: { status: string } }> {
  const projectId = await createProject(url);
  const response = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      agentId: 'claude',
      model: selection.model,
      reasoning: selection.reasoning,
      message: 'build a prototype',
      currentPrompt: 'build a prototype',
    }),
  });
  expect(response.status).toBe(202);
  const created = await response.json() as RunCreateBody;
  return { created, status: await waitForRun(url, created.runId) };
}

async function waitForRun(url: string, runId: string): Promise<{ status: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const run = await response.json() as { status: string };
    if (['failed', 'succeeded', 'canceled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

async function findDiagnostic(
  url: string,
  runId: string,
  type: string,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let text = '';
  try {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    while (!text.includes('event: end')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
  for (const block of text.split('\n\n')) {
    if (!block.includes('event: diagnostic')) continue;
    const data = block.split('\n').find((line) => line.startsWith('data: '));
    if (!data) continue;
    const payload = JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
    if (payload.type === type) return payload;
  }
  return null;
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd: daemonRoot,
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}
