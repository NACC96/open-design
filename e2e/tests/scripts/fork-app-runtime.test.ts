import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { readState, runInternal, withLock, writeState } from '../../../scripts/fork-app.ts';
import { emptyState, forkInstanceIdentity, launcherRuntimePath, resolveForkAppsPaths, withInstallRecord } from '../../../scripts/lib/fork-app.ts';

const faults = vi.hoisted(() => ({ failStateWrite: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (faults.failStateWrite && String(args[0]).includes('state.json')) {
        await fs.writeFile(args[0], '');
        throw new Error('simulated disk-full write');
      }
      return fs.writeFile(...args);
    },
  };
});

const scratch: string[] = [];

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'fork-app-runtime-'));
  scratch.push(home);
  const paths = resolveForkAppsPaths(home);
  await mkdir(paths.stateDir, { recursive: true });
  return paths;
}

afterEach(async () => {
  faults.failStateWrite = false;
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('fork-app mutation lock', () => {
  test('does not reclaim a lock whose creator has not published its PID', async () => {
    const paths = await fixture();
    const creator = await open(paths.lockPath, 'wx');
    try {
      const task = vi.fn();
      await expect(withLock(paths, task)).rejects.toThrow(/lock|another fork-app/);
      expect(task).not.toHaveBeenCalled();
      expect(await readFile(paths.lockPath, 'utf8')).toBe('');
    } finally {
      await creator.close();
    }
  });

  test('does not release a replacement lock owned by a different run', async () => {
    const paths = await fixture();
    await withLock(paths, async () => {
      await rm(paths.lockPath);
      await writeFile(paths.lockPath, 'replacement owner\n');
    });
    expect(await readFile(paths.lockPath, 'utf8')).toBe('replacement owner\n');
  });

  test('refuses a confirmation plan if another completed run changed its inputs', async () => {
    const paths = await fixture();
    const installedVersion = path.join(paths.stateDir, 'installed-version');
    await writeFile(installedVersion, 'version-one');
    const expected = await readFile(installedVersion, 'utf8');
    await withLock(paths, () => writeFile(installedVersion, 'version-three'));
    const mutate = vi.fn();

    await expect(withLock(paths, mutate, {
      expected,
      read: () => readFile(installedVersion, 'utf8'),
    })).rejects.toThrow(/changed.*plan|plan.*changed/i);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('fork-app rollback launcher selection', () => {
  test('refuses a rollback whose namespace can select a newer payload', async () => {
    const paths = await fixture();
    const identity = forkInstanceIdentity('stable');
    const namespaceBaseRoot = path.join(paths.home, 'library-root');
    const runtime = launcherRuntimePath(paths.home, identity, namespaceBaseRoot);
    await mkdir(path.dirname(runtime), { recursive: true });
    await writeFile(runtime, JSON.stringify({ active: { version: '0.24.1-fork.2', generation: 1 } }));

    await expect(runInternal({ paths, identity }, {
      type: 'assert-launcher-version', version: '0.24.1-fork.1', namespaceBaseRoot,
    })).rejects.toThrow(/newer.*payload|payload.*newer/i);
  });
});

describe('fork-app state durability', () => {
  const saved = withInstallRecord(emptyState(), 'stable', {
    commit: 'previous-commit',
    installedAt: '2026-10-15T00:00:00Z',
    ref: 'origin/custom',
    source: 'promote',
    version: '0.24.1-fork.1',
  });

  test('preserves the previous valid state when a replacement write fails', async () => {
    const paths = await fixture();
    await writeState(paths, saved);
    faults.failStateWrite = true;
    await expect(writeState(paths, emptyState())).rejects.toThrow('disk-full');
    expect(JSON.parse(await readFile(paths.statePath, 'utf8'))).toEqual(saved);
  });

  test('recovers history from the last valid backup when current JSON is incomplete', async () => {
    const paths = await fixture();
    await writeFile(`${paths.statePath}.backup`, JSON.stringify(saved));
    await writeFile(paths.statePath, '{"instances":');
    expect(await readState(paths)).toEqual(saved);
  });

  test('retains the last valid history while replacing the current state', async () => {
    const paths = await fixture();
    await writeState(paths, saved);
    await writeState(paths, emptyState());
    expect(JSON.parse(await readFile(`${paths.statePath}.backup`, 'utf8'))).toEqual(saved);
    await writeFile(paths.statePath, '{');
    expect(await readState(paths)).toEqual(saved);
  });
});
