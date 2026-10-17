import { spawn } from 'node:child_process';
import {
  captureProcessSnapshot,
  captureProcessSnapshotsByPids,
  createCommandInvocation,
  selectOwnedProcessTree,
  stopProcesses,
  terminateProcessGroup,
} from '@open-design/platform';

export interface CodexProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Own a Codex subprocess until its streams close AND its process tree is reaped.
 * Do not pass AbortSignal to spawn/execFile: their abort error is not an exit
 * witness. Only read-only queries may opt into a deadline/output limit.
 */
export function spawnOwnedCodexProcess(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  query?: { timeoutMs: number; maxOutputBytes: number };
}) {
  input.signal?.throwIfAborted();
  const invocation = createCommandInvocation(input);
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: 'pipe',
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  let failure: unknown;
  let stopReason: unknown;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  const identity = process.platform === 'win32' && child.pid
    ? captureProcessSnapshotsByPids([child.pid]).catch(() => [])
    : Promise.resolve([]);
  const terminateOwnedTree = (): Promise<void> => {
    termination ??= (async () => {
      if (!child.pid) return;
      if (process.platform !== 'win32') {
        const result = await terminateProcessGroup(child.pid, { termGraceMs: 3_000, killGraceMs: 3_000 });
        if (result.survived) throw new Error('Codex process group survived teardown');
      } else {
        const known = await identity;
        const current = await captureProcessSnapshot();
        const owned = selectOwnedProcessTree(known, current);
        const result = await stopProcesses(owned.map(entry => entry.pid), { termGraceMs: 3_000, killGraceMs: 3_000 });
        if (result.remainingPids.length > 0) throw new Error('Codex process tree survived teardown');
      }
    })();
    return termination;
  };
  const requestStop = (reason: unknown) => {
    if (settled) return;
    stopReason ??= reason;
    clearTimeout(timer);
    void terminateOwnedTree().catch(error => { failure = error; });
  };
  const onAbort = () => requestStop(input.signal?.reason);
  const completion = new Promise<CodexProcessExit>((resolve, reject) => {
    child.once('error', error => { failure = error; });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') failure = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Even normal query completion can leave a wrapper descendant behind.
      // The root has exited now: release that remaining ownership as well.
      void terminateOwnedTree().then(() => {
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        if (failure != null) reject(failure);
        else if (stopReason != null) reject(stopReason);
        else resolve({ code, signal });
      }, error => {
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  });
  // Callers attach their result handlers synchronously after stream setup.
  void completion.catch(() => {});
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  if (input.query && !input.signal?.aborted) {
    timer = setTimeout(() => requestStop(new Error('Codex readiness query timed out')), input.query.timeoutMs);
    timer.unref();
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      stream.on('data', (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > input.query!.maxOutputBytes) requestStop(new Error('Codex readiness query output exceeded its limit'));
      });
    }
  }
  return { child, completion };
}
