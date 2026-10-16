import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRoutineExecution } from '../../src/automations/runtime-selection.js';
import { RoutineService, type Routine, type RoutineRun } from '../../src/routines.js';

const prefs = {
  amr: { model: 'cloud-only', reasoning: 'cloud-effort', serviceTier: 'cloud-tier' },
  'byok-opencode': { model: 'provider-only', reasoning: 'provider-effort' },
  claude: { model: 'claude-fable-5', reasoning: 'high' },
  codex: { model: 'gpt-5.5', reasoning: 'low', serviceTier: 'fast' },
};
const installed = [
  { id: 'claude', available: true }, { id: 'codex', available: true },
];

afterEach(() => vi.useRealTimers());

describe('routine Local AI runtime selection', () => {
  it.each(['amr', 'byok-opencode'])('replaces a retired %s override with the available app agent and only its preferences', async (agentId) => {
    const routine = Object.freeze({ agentId });
    const app = { agentId: 'codex', agentModels: prefs, agentCliEnv: { codex: { CODEX_HOME: '/configured-codex' } } };
    const before = structuredClone(app);
    const detect = vi.fn(async () => installed);
    await expect(resolveRoutineExecution(routine, app, detect)).resolves.toEqual({ agentId: 'codex', ...prefs.codex });
    expect(detect).toHaveBeenCalledWith(app.agentCliEnv);
    expect(app).toEqual(before);
    expect(routine.agentId).toBe(agentId);
  });

  it('uses the local default when the inherited app selection is also retired', async () => {
    await expect(resolveRoutineExecution({ agentId: 'byok-opencode' }, { agentId: 'amr', agentModels: prefs }, async () => installed)).resolves.toEqual({
      agentId: 'claude', ...prefs.claude, serviceTier: null,
    });
  });

  it('ignores unavailable or retired detector entries when recovering a retired selection', async () => {
    await expect(resolveRoutineExecution({ agentId: 'amr' }, { agentId: 'claude', agentModels: prefs }, async () => [
      { id: 'amr', available: true }, { id: 'claude', available: false }, { id: 'opencode', available: true },
    ])).resolves.toEqual({ agentId: 'opencode', model: null, reasoning: null, serviceTier: null });
  });

  it('recovers a retired app default even without a routine override', async () => {
    await expect(resolveRoutineExecution({ agentId: null }, { agentId: 'amr' }, async () => installed)).resolves.toEqual({
      agentId: 'claude', model: null, reasoning: null, serviceTier: null,
    });
  });

  it('keeps the existing detection fallback for a malformed app selection', async () => {
    await expect(resolveRoutineExecution({ agentId: null }, { agentId: 42 as unknown as string }, async () => installed)).resolves.toMatchObject({ agentId: 'claude' });
  });

  it('keeps an explicit local override and its own preferences without switching agents', async () => {
    const detect = vi.fn(async () => installed);
    await expect(resolveRoutineExecution({ agentId: 'codex' }, { agentId: 'claude', agentModels: prefs }, detect)).resolves.toEqual({ agentId: 'codex', ...prefs.codex });
    expect(detect).not.toHaveBeenCalled();
  });

  it('leaves an uninstalled explicit local override for the normal runtime error instead of silently replacing it', async () => {
    const detect = vi.fn(async () => installed);
    await expect(resolveRoutineExecution({ agentId: 'my-local-profile' }, { agentId: 'claude' }, detect)).resolves.toMatchObject({ agentId: 'my-local-profile' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('reports no available local agent when a retired selection has no replacement', async () => {
    await expect(resolveRoutineExecution({ agentId: 'amr' }, {}, async () => [])).rejects.toThrow('No available agent');
  });
});

describe('routine execution triggers', () => {
  it.each(['manual', 'scheduled'] as const)('resolves %s execution while preserving saved settings and prior history', async (trigger) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:00:00Z'));
    const routine: Routine = {
      id: 'old-routine', name: 'Keep this name', prompt: 'Keep this prompt',
      agentId: 'amr', skillId: null, context: {}, enabled: true,
      schedule: { kind: 'hourly', minute: 1 }, target: { mode: 'create_each_run' },
      nextRunAt: null, lastRun: null, createdAt: 1, updatedAt: 2,
    };
    const saved = structuredClone(routine);
    const oldRun = { id: 'old-run', routineId: routine.id, status: 'succeeded' } as RoutineRun;
    const history: RoutineRun[] = [oldRun];
    const service = new RoutineService({
      list: () => [routine],
      insertRun: (run) => { history.push(run); return true; },
      updateRun: (id, patch) => Object.assign(history.find((row) => row.id === id)!, patch),
      getLatestRun: () => history.at(-1) ?? null,
    });
    const dispatch = vi.fn();
    service.setRunHandler(async ({ routine, trigger }) => {
      const execution = await resolveRoutineExecution(routine, { agentId: 'codex', agentModels: prefs }, async () => installed);
      return {
        projectId: 'local-project', conversationId: 'local-conversation', agentRunId: 'local-run',
        completion: Promise.resolve({ status: 'succeeded' }),
        start: () => dispatch(trigger, execution),
      };
    });
    try {
      if (trigger === 'manual') await service.runNow(routine.id);
      else { service.start(); await vi.advanceTimersByTimeAsync(60_000); }
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(trigger, { agentId: 'codex', ...prefs.codex });
      expect(routine).toEqual(saved);
      expect(history[0]).toBe(oldRun);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({ routineId: routine.id, trigger });
    } finally { service.stop(); }
  });
});
