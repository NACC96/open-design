// A project's execution stamp, end to end through `POST /api/runs` with a
// fake Claude binary: the stamp picks the agent when the request names none,
// its model and reasoning reach argv when the request omits them, a stamp
// without a model runs on the CLI default instead of the global saved model,
// and anything the request does name wins.
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type RunCreateBody = {
  runId: string;
  reasoning?: { requested: string; applied: string | null; options: string[] };
  agentResolution?: { agentId: string; source: string; projectAgentId?: string };
};

const GLOBAL_CLAUDE_MODEL = 'claude-opus-5-5';

describe('project execution stamp through POST /api/runs', () => {
  let started: StartedServer;
  let binDir: string;
  let argvLog: string;
  let originalConfig: Record<string, unknown> = {};

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-project-execution-run-'));
    argvLog = path.join(binDir, 'argv.log');
    const bin = await writeFakeClaude(binDir, argvLog);
    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    const current = await fetch(`${started.url}/api/app-config`);
    originalConfig = ((await current.json()) as { config: Record<string, unknown> }).config ?? {};
    await putConfig({
      agentId: 'claude',
      // A global saved model that a stamped project must never inherit.
      agentModels: { claude: { model: GLOBAL_CLAUDE_MODEL } },
      agentCliEnv: { claude: { CLAUDE_BIN: bin } },
      telemetry: { metrics: false, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
      odNextStrategyMode: 'off',
    });
  });

  afterEach(async () => {
    await rm(argvLog, { force: true });
  });

  afterAll(async () => {
    // The vitest data dir is shared by every file in this process.
    await putConfig({
      agentId: originalConfig.agentId ?? null,
      agentModels: originalConfig.agentModels ?? {},
      agentCliEnv: originalConfig.agentCliEnv ?? {},
      odNextStrategyMode: originalConfig.odNextStrategyMode ?? null,
    });
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) await new Promise<void>((resolve) => started.server.close(() => resolve()));
    if (binDir) await rm(binDir, { recursive: true, force: true });
  });

  async function putConfig(patch: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${started.url}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
  }

  async function createProject(execution: Record<string, unknown> | null | undefined): Promise<string> {
    const projectId = `execution_run_${randomUUID()}`;
    const response = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Project execution stamp',
        metadata: { kind: 'prototype' },
        skipDiscoveryBrief: true,
        ...(execution === undefined ? {} : { execution }),
      }),
    });
    expect(response.status).toBe(200);
    return projectId;
  }

  async function run(
    execution: Record<string, unknown> | null | undefined,
    request: Record<string, unknown>,
  ): Promise<{ created: RunCreateBody; args: string[] }> {
    const projectId = await createProject(execution);
    const response = await fetch(`${started.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        message: 'build a prototype',
        currentPrompt: 'build a prototype',
        ...request,
      }),
    });
    expect(response.status).toBe(202);
    const created = await response.json() as RunCreateBody;
    const status = await waitForRun(started.url, created.runId);
    expect(status.status).toBe('succeeded');
    return { created, args: await runArgv(argvLog) };
  }

  it('runs on the stamped agent, model, and reasoning when the request names none', async () => {
    const { created, args } = await run(
      { agentId: 'claude', model: 'claude-sonnet-5-5', reasoning: 'xhigh' },
      {},
    );
    expect(created.agentResolution).toEqual({ agentId: 'claude', source: 'project' });
    // The request carried no reasoning, so none is reported back.
    expect(created).not.toHaveProperty('reasoning');
    expect(flagValue(args, '--model')).toBe('claude-sonnet-5-5');
    expect(flagValue(args, '--effort')).toBe('xhigh');
  });

  it('runs a stamp without a model on the CLI default, never the global saved model', async () => {
    const { created, args } = await run({ agentId: 'claude' }, { agentId: 'claude' });
    expect(created).not.toHaveProperty('agentResolution');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('runs a project created without a stamp on the app-config agent and saved model', async () => {
    const { created, args } = await run(undefined, {});
    expect(created.agentResolution).toEqual({ agentId: 'claude', source: 'app-config' });
    expect(flagValue(args, '--model')).toBe(GLOBAL_CLAUDE_MODEL);
  });

  it('lets the request model win and does not carry the stamp reasoning onto it', async () => {
    const { args } = await run(
      { agentId: 'claude', model: 'claude-sonnet-5-5', reasoning: 'xhigh' },
      { agentId: 'claude', model: 'claude-opus-5' },
    );
    expect(flagValue(args, '--model')).toBe('claude-opus-5');
    expect(args).not.toContain('--effort');
  });

  it('lets the request reasoning win and validates it against the stamped model', async () => {
    const { created, args } = await run(
      { agentId: 'claude', model: 'claude-sonnet-4-6', reasoning: 'high' },
      { reasoning: 'xhigh' },
    );
    // claude-sonnet-4-6 has no xhigh: the response says so against the model
    // the run actually uses (the stamp's), not the global saved one.
    expect(created.reasoning).toEqual({
      requested: 'xhigh',
      applied: null,
      options: ['default', 'low', 'medium', 'high', 'max'],
    });
    expect(flagValue(args, '--model')).toBe('claude-sonnet-4-6');
    expect(args).not.toContain('--effort');
  });
});

async function writeFakeClaude(dir: string, argvLog: string): Promise<string> {
  const bin = path.join(dir, 'claude-fake');
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('2.1.299 (Claude Code)'); process.exit(0); }
if (args.includes('--help')) {
  console.log('Usage: claude -p [--include-partial-messages] [--add-dir DIR] [--effort <level>]');
  process.exit(0);
}
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (!args.includes('--output-format')) { console.error("error: unknown option '" + args[1] + "'"); process.exit(1); }
const W = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n');
W({ type: 'system', subtype: 'init', model: 'execution-test' });
W({ type: 'assistant', message: { id: 'm_done', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } });
process.exit(0);
`, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

async function runArgv(argvLog: string): Promise<string[]> {
  const raw = await readFile(argvLog, 'utf8').catch(() => '');
  const runs = raw.split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args.includes('--output-format'));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
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
