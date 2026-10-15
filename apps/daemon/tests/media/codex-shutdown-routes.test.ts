import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renderState = vi.hoisted(() => ({
  started: (_signal: AbortSignal | undefined) => {},
  exited: false,
}));

vi.mock('../../src/media/codex-imagegen.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/media/codex-imagegen.js')>(),
  renderCodexImage: vi.fn((input: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    input.signal?.addEventListener('abort', () => {
      renderState.exited = true;
      reject(input.signal?.reason);
    }, { once: true });
    renderState.started(input.signal);
  })),
}));

import { startServer } from '../../src/server.js';

type StartedServer = { url: string; server: Server; shutdown: () => Promise<void> };
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.shutdown();
  if (started) {
    started.server.closeAllConnections();
    await new Promise<void>(resolve => started!.server.close(() => resolve()));
  }
  started = undefined;
});

describe('daemon ownership of Codex image generation', () => {
  it('routes HTTP generation through the owner and drains it during daemon shutdown', async () => {
    const rendering = new Promise<AbortSignal | undefined>(resolve => { renderState.started = resolve; });
    renderState.exited = false;
    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    const projectId = 'codex-shutdown-route';
    const project = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Shutdown fixture', metadata: {kind: 'image'} }),
    });
    expect(project.status).toBe(200);
    const request = await fetch(`${started.url}/api/projects/${projectId}/media/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface: 'image', model: 'codex-gpt-image-2', prompt: 'fixture' }),
    });
    expect(request.status).toBe(202);
    const signal = await rendering;
    expect(signal?.aborted).toBe(false);
    await started.shutdown();
    expect(signal?.aborted).toBe(true);
    expect(renderState.exited).toBe(true);
  });
});
