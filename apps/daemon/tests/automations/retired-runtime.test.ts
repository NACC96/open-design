import type { Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dispatched = vi.hoisted(() => vi.fn());

vi.mock('../../src/agents.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/agents.js')>(),
  detectAgents: vi.fn(async () => [
    { id: 'claude', available: true }, { id: 'codex', available: true },
  ]),
}));
vi.mock('../../src/services/internal-run-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/internal-run-service.js')>();
  return {
    ...actual,
    createInternalRunCreationService(deps: Parameters<typeof actual.createInternalRunCreationService>[0]) {
      const service = actual.createInternalRunCreationService(deps);
      const start = service.start;
      service.start = (run, analytics, starter) => {
        dispatched(analytics.body);
        return start(run, analytics, starter);
      };
      return service;
    },
  };
});

import { startServer } from '../../src/server.js';
import { writeAppConfig } from '../../src/app-config.js';

let started: { url: string; server: Server; shutdown?: () => void | Promise<void> } | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await started?.shutdown?.();
  if (started) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
  started = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
  vi.unstubAllEnvs();
  dispatched.mockClear();
});

describe('Run now for stored retired-runtime automations', () => {
  it.each(['amr', 'byok-opencode'])('starts %s history on the chosen local agent without mutating the routine', async (agentId) => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'od-local-routine-'));
    const recording = path.join(scratch, 'events.jsonl');
    await writeFile(recording, JSON.stringify({ id: 1, timestamp: 0, event: 'end', data: { status: 'succeeded', code: 0 } }) + '\n');
    // The production replay seam settles a Run without invoking any CLI/provider.
    vi.stubEnv('OD_REPLAY_EVENTS', recording);
    vi.stubEnv('OD_REPLAY_DIR', '');
    const dataDir = process.env.OD_DATA_DIR!;
    await writeAppConfig(dataDir, {
      agentId: 'codex',
      agentModels: {
        [agentId]: { model: 'cloud-only', reasoning: 'cloud-only', serviceTier: 'cloud-only' },
        codex: { model: 'gpt-5.5', reasoning: 'low', serviceTier: 'fast' },
      },
    });
    started = await startServer({ port: 0, returnServer: true }) as NonNullable<typeof started>;
    const create = await fetch(`${started.url}/api/routines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Legacy ${agentId}`, prompt: 'Preserve this prompt', agentId,
        schedule: { kind: 'hourly', minute: 1 }, target: { mode: 'create_each_run' }, enabled: false,
      }),
    });
    expect(create.status).toBe(201);
    const { routine } = await create.json() as { routine: { id: string; agentId: string; name: string; prompt: string } };
    const fire = await fetch(`${started.url}/api/routines/${routine.id}/run`, { method: 'POST' });
    expect(fire.status).toBe(202);
    const fired = await fire.json() as { agentRunId: string };
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex', model: 'gpt-5.5', reasoning: 'low', serviceTier: 'fast',
    }));
    await vi.waitFor(async () => {
      const response = await fetch(`${started!.url}/api/runs/${fired.agentRunId}`);
      const result = await response.json() as { agentId: string; status: string };
      expect(result).toMatchObject({ agentId: 'codex', status: 'succeeded' });
    });
    const stored = await fetch(`${started.url}/api/routines/${routine.id}`);
    expect(await stored.json()).toMatchObject({ routine: {
      id: routine.id, agentId, name: routine.name, prompt: routine.prompt, enabled: false,
    } });
    const history = await fetch(`${started.url}/api/routines/${routine.id}/runs`);
    expect(await history.json()).toMatchObject({ runs: [expect.objectContaining({ agentRunId: fired.agentRunId })] });
  });
});

describe('headless Orbit before web config migration', () => {
  it.each(['amr', 'byok-opencode'])('uses an available local runtime for persisted %s', async (agentId) => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'od-local-orbit-'));
    const recording = path.join(scratch, 'events.jsonl');
    await writeFile(recording, JSON.stringify({ id: 1, timestamp: 0, event: 'end', data: { status: 'succeeded', code: 0 } }) + '\n');
    vi.stubEnv('OD_REPLAY_EVENTS', recording);
    vi.stubEnv('OD_REPLAY_DIR', '');
    const configPath = path.join(process.env.OD_DATA_DIR!, 'app-config.json');
    // Seed the old file directly: no browser load or new-version config writer.
    const saved = JSON.stringify({
      agentId, telemetry: { metrics: false, content: false },
      agentModels: {
        [agentId]: { model: 'cloud-only', reasoning: 'cloud-only', serviceTier: 'cloud-only' },
        claude: { model: 'claude-fable-5', reasoning: 'high' },
      },
      orbit: { enabled: false, intervalMinutes: 60, maxTokens: 4096, templateSkillId: null },
    });
    await writeFile(configPath, saved);
    started = await startServer({ port: 0, returnServer: true }) as NonNullable<typeof started>;
    const result = await fetch(`${started.url}/api/orbit/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(result.status).toBe(200);
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude', model: 'claude-fable-5', reasoning: 'high', serviceTier: null,
    }));
    expect(await readFile(configPath, 'utf8')).toBe(saved);
  });
});
