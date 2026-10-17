// Per-project agent + model stamp (`Project.execution`) through the real
// daemon routes: only an explicit `execution` stamps a project (the daemon
// never defaults one from app-config), the stamp survives app-config changes
// and metadata patches, PATCH replaces or clears it, and forks / duplicates
// copy the source's stamp.
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project, ProjectExecutionChoice } from '@open-design/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../../src/server.js';

type Started = { url: string; server: http.Server; shutdown?: () => Promise<void> | void };

describe('project execution stamp routes', () => {
  let started: Started;
  let baseUrl: string;
  let originalConfig: Record<string, unknown> = {};

  beforeAll(async () => {
    started = (await startServer({ port: 0, returnServer: true })) as Started;
    baseUrl = started.url;
    const response = await fetch(`${baseUrl}/api/app-config`);
    originalConfig = ((await response.json()) as { config: Record<string, unknown> }).config ?? {};
  });

  afterAll(async () => {
    // The vitest data dir is shared by every file in this process.
    await putConfig({
      agentId: originalConfig.agentId ?? null,
      agentModels: originalConfig.agentModels ?? {},
    });
    await Promise.resolve(started?.shutdown?.());
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  async function putConfig(patch: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${baseUrl}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
  }

  async function createProject(extra: Record<string, unknown> = {}) {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `execution_${randomUUID()}`,
        name: 'Execution stamp',
        metadata: { kind: 'prototype' },
        ...extra,
      }),
    });
    return {
      status: response.status,
      body: await response.json() as { project: Project; conversationId: string; error?: { code: string; message: string } },
    };
  }

  async function getProject(id: string): Promise<Project> {
    const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { project: Project }).project;
  }

  async function patchProject(id: string, patch: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return { status: response.status, body: await response.json() as { project: Project; error?: { code: string; message: string } } };
  }

  it('leaves a project unstamped when the creator names no agent, whatever app-config says', async () => {
    await putConfig({
      agentId: 'codex',
      agentModels: { codex: { model: 'gpt-5-codex', reasoning: 'high' } },
    });
    const omitted = await createProject();
    expect(omitted.status).toBe(200);
    expect(omitted.body.project.execution).toBeUndefined();
    expect((await getProject(omitted.body.project.id)).execution).toBeUndefined();

    const explicitNull = await createProject({ execution: null });
    expect(explicitNull.status).toBe(200);
    expect(explicitNull.body.project.execution).toBeUndefined();
  });

  it('saves an explicit stamp and keeps it after app-config changes', async () => {
    await putConfig({ agentId: 'claude', agentModels: {} });
    const expected: ProjectExecutionChoice = { agentId: 'codex', model: 'default', serviceTier: 'priority' };
    const explicit = await createProject({ execution: expected });
    expect(explicit.status).toBe(200);
    expect(explicit.body.project.execution).toEqual(expected);

    await putConfig({ agentId: 'claude', agentModels: { codex: { model: 'gpt-5' } } });
    expect((await getProject(explicit.body.project.id)).execution).toEqual(expected);
  });

  it.each([
    ['a retired runtime', { agentId: 'amr' }],
    ['an unknown agent', { agentId: 'not-a-real-agent' }],
    ['a flag-shaped model', { agentId: 'claude', model: '--yolo' }],
    ['an unknown key', { agentId: 'claude', cwd: '/' }],
  ])('rejects %s on create without creating the project', async (_label, execution) => {
    const id = `execution_${randomUUID()}`;
    const created = await createProject({ id, execution });
    expect(created.status).toBe(400);
    expect(created.body.error?.code).toBe('BAD_REQUEST');
    expect(created.body.error?.message).toMatch(/^execution/);
    const lookup = await fetch(`${baseUrl}/api/projects/${id}`);
    expect(lookup.status).toBe(404);
  });

  it('replaces, keeps, and clears the stamp through PATCH', async () => {
    const created = await createProject({ execution: { agentId: 'codex', model: 'gpt-5-codex' } });
    const id = created.body.project.id;

    const replaced = await patchProject(id, { execution: { agentId: 'claude', reasoning: 'max' } });
    expect(replaced.status).toBe(200);
    expect(replaced.body.project.execution).toEqual({ agentId: 'claude', reasoning: 'max' });

    // A stale whole-metadata patch (auto-title) and a rename must not revert it.
    const metadataOnly = await patchProject(id, { metadata: { kind: 'prototype', nameSource: 'generated' } });
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.body.project.execution).toEqual({ agentId: 'claude', reasoning: 'max' });
    const renamed = await patchProject(id, { name: 'Renamed' });
    expect(renamed.body.project.execution).toEqual({ agentId: 'claude', reasoning: 'max' });

    const rejected = await patchProject(id, { execution: { agentId: 'byok-opencode' } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe('BAD_REQUEST');
    expect((await getProject(id)).execution).toEqual({ agentId: 'claude', reasoning: 'max' });

    const cleared = await patchProject(id, { execution: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.project.execution).toBeUndefined();
    expect((await getProject(id)).execution).toBeUndefined();
  });

  it('leaves a folder import unstamped', async () => {
    await putConfig({ agentId: 'codex', agentModels: { codex: { model: 'gpt-5-codex' } } });
    const folder = await mkdtemp(path.join(tmpdir(), 'od-execution-import-'));
    try {
      await writeFile(path.join(folder, 'index.html'), '<!doctype html>');
      const response = await fetch(`${baseUrl}/api/import/folder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseDir: folder }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { project: Project }).project.execution).toBeUndefined();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('lists the stamp on the project catalog', async () => {
    const created = await createProject({ execution: { agentId: 'codex' } });
    const response = await fetch(`${baseUrl}/api/projects`);
    expect(response.status).toBe(200);
    const { projects } = await response.json() as { projects: Project[] };
    expect(projects.find((project) => project.id === created.body.project.id)?.execution)
      .toEqual({ agentId: 'codex' });
  });

  it('forks and duplicates with the source stamp, and leaves copies of an unstamped source unstamped', async () => {
    await putConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-sonnet-4-6' } } });
    const stamped = await createProject({ execution: { agentId: 'codex', model: 'gpt-5-codex' } });
    const source = stamped.body.project.id;
    const messageId = `brief_${randomUUID()}`;
    const saved = await fetch(
      `${baseUrl}/api/projects/${source}/conversations/${stamped.body.conversationId}/messages/${messageId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: messageId, role: 'user', content: 'Make a poster.' }),
      },
    );
    expect(saved.status).toBe(200);

    const fork = await fetch(`${baseUrl}/api/projects/${source}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceConversationId: stamped.body.conversationId, sourceMessageId: messageId }),
    });
    expect(fork.status).toBe(201);
    expect(((await fork.json()) as { project: Project }).project.execution)
      .toEqual({ agentId: 'codex', model: 'gpt-5-codex' });

    const duplicate = await fetch(`${baseUrl}/api/projects/${source}/duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { project: Project }).project.execution)
      .toEqual({ agentId: 'codex', model: 'gpt-5-codex' });

    const unstamped = await createProject({ execution: null });
    const duplicateOfUnstamped = await fetch(`${baseUrl}/api/projects/${unstamped.body.project.id}/duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(duplicateOfUnstamped.status).toBe(200);
    expect(((await duplicateOfUnstamped.json()) as { project: Project }).project.execution)
      .toBeUndefined();
  });
});
