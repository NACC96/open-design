import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executePlan, runInternal } from '../../../scripts/fork-app.ts';
import { forkInstanceIdentity, resolveForkAppsPaths, type PlanStep } from '../../../scripts/lib/fork-app.ts';

const os = vi.hoisted(() => ({
  previous: 'io.open-design.desktop.fork',
  handler: 'io.open-design.desktop.fork',
  commands: [] as string[][],
  afterOpen: undefined as (() => void) | undefined,
}));

vi.mock('node:child_process', () => ({
  spawnSync: (command: string) => ({
    status: 0, stderr: '',
    stdout: command === 'osascript' ? os.handler : command === 'git' ? 'wrong-commit' : '',
  }),
  spawn: (command: string, args: string[]) => {
    const child = new EventEmitter();
    os.commands.push([command, ...args]);
    queueMicrotask(() => {
      if (command === 'open') {
        os.handler = 'io.open-design.desktop.dev';
        os.afterOpen?.();
      }
      if (command === 'osascript') os.handler = os.previous;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  },
}));

const identity = forkInstanceIdentity('dev');
const paths = resolveForkAppsPaths('/fixture-home');

beforeEach(() => {
  os.handler = os.previous;
  os.commands = [];
  os.afterOpen = undefined;
});

afterEach(() => vi.useRealTimers());

describe('temporary Dev invite ownership', () => {
  test('restores the previous owner after the actual delayed startup claim', async () => {
    vi.useFakeTimers();
    const restoring = runInternal({ paths, identity, previousInviteHandler: os.previous }, {
      type: 'restore-invite-handler',
    });
    setTimeout(() => { os.handler = identity.bundleId; }, 8_000);

    await vi.advanceTimersByTimeAsync(10_000);
    await restoring;

    expect(os.handler).toBe(os.previous);
  });

  test.each([false, true])('restores ownership after launch failure or handled interruption (abort=%s)', async (abort) => {
    const controller = new AbortController();
    if (abort) os.afterOpen = () => controller.abort(new Error('interrupted fixture'));
    const plan: PlanStep[] = [
      { kind: 'run', label: 'stop Dev', cwd: paths.buildWorktree,
        argv: ['pnpm', 'tools-pack', 'mac', 'stop', '--namespace', identity.namespace, '--app-version', '0.24.1-dev.1', '--json'] },
      { kind: 'internal', label: 'remember invite owner', action: { type: 'remember-invite-handler' } },
      { kind: 'run', label: 'launch Dev', cwd: paths.home, argv: ['open', '/fixture-home/Applications/Open Design Dev.app'] },
      { kind: 'internal', label: 'forced failure', action: { type: 'assert-worktree-head', commit: 'expected-commit' } },
    ];

    await expect(executePlan({ paths, identity, signal: controller.signal }, plan)).rejects.toThrow(
      abort ? 'interrupted fixture' : 'expected expected-commit',
    );

    expect(os.handler).toBe(os.previous);
    expect(os.commands.filter(command => command.includes('stop'))).toHaveLength(2);
  });
});
