import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForkProjectResponse } from '@open-design/contracts';
import * as store from '../../src/db.js';
import * as files from '../../src/projects.js';
import { forkAttachmentPath } from '../../src/projects/fork.js';
import { registerProjectRoutes } from '../../src/routes/project/index.js';
import { getSnapshot, resolvePluginFolder, resolvePluginSnapshot, upsertInstalledPlugin } from '../../src/plugins/index.js';

let root: string;
let projectsRoot: string;
let db: ReturnType<typeof store.openDatabase>;
let server: Server;
let base: string;
let authorize = vi.fn(async (_req: Request, _res: Response, _projectId: string, _options: unknown) => true);
let insertConversation: typeof store.insertConversation;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-project-fork-'));
  projectsRoot = path.join(root, 'projects');
  db = store.openDatabase(root, { dataDir: root });
  const now = Date.now();
  store.insertProject(db, {
    id: 'source', name: 'Price list', skillId: 'print', designSystemId: 'brand',
    customInstructions: 'Use real prices. Preserve the logo.',
    metadata: { kind: 'other', fidelity: 'high-fidelity', imageAspect: '3:4',
      entryFile: 'generated.html', linkedDirs: ['/external'], sharedProjectPlaceholderAt: 1 },
    createdAt: now, updatedAt: now,
  });
  store.insertConversation(db, { id: 'source-chat', projectId: 'source', title: 'Brief', sessionMode: 'design', createdAt: now, updatedAt: now });
  store.upsertMessage(db, 'source-chat', {
    id: 'brief', role: 'user', content: '  Make a price list.\nKeep the exact prices.  ',
    attachments: [
      { name: 'Price list.xlsx', path: 'inputs/Price list.xlsx', kind: 'file', order: 0 },
      { name: 'Logo.png', path: path.join(projectsRoot, 'source', 'logo.png'), kind: 'image', order: 1 },
    ],
  });
  store.upsertMessage(db, 'source-chat', { id: 'reply', role: 'assistant', content: 'Generated design', runStatus: 'succeeded' });
  await mkdir(path.join(projectsRoot, 'source', 'inputs'), { recursive: true });
  await writeFile(path.join(projectsRoot, 'source', 'inputs', 'Price list.xlsx'), Buffer.from([0, 255, 1, 2]));
  await writeFile(path.join(projectsRoot, 'source', 'logo.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(projectsRoot, 'source', 'generated.html'), '<p>unrelated output</p>');
  authorize = vi.fn(async (_req: Request, _res: Response, _projectId: string, _options: unknown) => true);
  insertConversation = store.insertConversation;
  const app = express();
  app.use(express.json());
  registerProjectRoutes(app, {
    db, design: {},
    http: { sendApiError: (res: Response, status: number, code: string, message: string, extra = {}) => res.status(status).json({ error: { code, message, ...extra } }) },
    paths: { PROJECTS_DIR: projectsRoot, RUNTIME_DATA_DIR: root },
    projectStore: { ...store, dbDeleteProject: store.deleteProject, removeProjectDir: files.removeProjectDir },
    projectFiles: files,
    conversations: { ...store, insertConversation: (...args: Parameters<typeof store.insertConversation>) => insertConversation(...args) },
    templates: {}, status: {}, events: {}, agents: {}, telemetry: {}, ids: { randomId: randomUUID },
    appConfig: { readAppConfig: async () => ({}) }, validation: {},
    authorizeProjectRequest: (...args: Parameters<typeof authorize>) => authorize(...args),
    pluginScope: {
      getPlugin: async (id: string) => (await import('../../src/plugins/registry.js')).getInstalledPlugin(db, id),
      loadRegistry: async () => ({ skills: [], designSystems: [], craft: [], atoms: [] }),
    },
    fetchProjectCreationWorkspaceDirectory: async () => ({ ok: false, items: [] }),
  } as unknown as Parameters<typeof registerProjectRoutes>[1]);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) store.closeDatabase();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fork(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/projects/source/fork`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ sourceConversationId: 'source-chat', sourceMessageId: 'brief', ...body }),
  });
}

describe('fork a saved brief into an independent project', () => {
  it('copies ordered attachments byte-for-byte, preserves the brief and instructions, and starts no chat or run', async () => {
    const response = await fork();
    expect(response.status).toBe(201);
    const result = await response.json() as ForkProjectResponse;
    expect(result.project.name).toBe('Price list Fork');
    expect(result.project.pendingPrompt).toBe('  Make a price list.\nKeep the exact prices.  ');
    expect(result.project).toMatchObject({ skillId: 'print', designSystemId: 'brand', customInstructions: 'Use real prices. Preserve the logo.' });
    expect(result.project.metadata).toMatchObject({ kind: 'other', fidelity: 'high-fidelity', imageAspect: '3:4', pendingDraftConversationId: result.conversationId });
    expect(result.project.metadata).not.toHaveProperty('entryFile');
    expect(result.project.metadata).not.toHaveProperty('linkedDirs');
    expect(result.project.metadata).not.toHaveProperty('sharedProjectPlaceholderAt');
    expect(result.copiedFiles).toEqual(['inputs/Price list.xlsx', 'logo.png']);
    expect(result.project.metadata?.pendingAttachments).toEqual([
      { name: 'Price list.xlsx', path: 'inputs/Price list.xlsx', kind: 'file', size: 4, order: 0 },
      { name: 'Logo.png', path: 'logo.png', kind: 'image', size: 4, order: 1 },
    ]);
    for (const name of result.copiedFiles) {
      expect(await readFile(path.join(projectsRoot, result.project.id, name))).toEqual(await readFile(path.join(projectsRoot, 'source', name)));
    }
    expect(store.listMessages(db, result.conversationId)).toEqual([]);
    expect(store.listConversations(db, result.project.id)).toHaveLength(1);
    expect(await readdir(path.join(projectsRoot, result.project.id))).not.toContain('generated.html');
    store.deleteProject(db, 'source');
    await rm(path.join(projectsRoot, 'source'), { recursive: true });
    expect(await readFile(path.join(projectsRoot, result.project.id, 'logo.png'))).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('supports attachments-only drafts and an explicit prompt override', async () => {
    const response = await fork({ prompt: '', name: 'Another direction' });
    expect(response.status).toBe(201);
    const result = await response.json() as ForkProjectResponse;
    expect(result.project.pendingPrompt).toBe('');
    expect(result.project.name).toBe('Another direction');
    expect(result.project.metadata?.pendingAttachments).toHaveLength(2);
  });

  it('binds the fork privately to the same workspace and uses duplicate authorization', async () => {
    const response = await fork({}, {
      'x-od-workspace-id': 'workspace-1', 'x-od-workspace-member-id': 'member-1',
      'x-od-workspace-role': 'owner', 'x-od-workspace-type': 'team',
      'x-od-workspace-member-status': 'active', 'x-od-workspace-lifecycle-state': 'active',
    });
    expect(response.status).toBe(201);
    const result = await response.json() as ForkProjectResponse;
    expect(result.project.workspaceId).toBe('workspace-1');
    expect(store.getWorkspaceProjectByProjectId(db, result.project.id)).toMatchObject({
      workspaceId: 'workspace-1', visibility: 'personal', syncState: 'local_only', createdByWorkspaceMemberId: 'member-1',
    });
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'source', { mode: 'write', capability: 'duplicate' });
  });

  it('creates no files or records when project access is denied', async () => {
    authorize.mockImplementation(async (_req: Request, res: Response) => {
      res.status(403).json({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
      return false;
    });
    expect((await fork()).status).toBe(403);
    expect(await readdir(projectsRoot)).toEqual(['source']);
    expect(store.listProjects(db)).toHaveLength(1);
  });

  it('clears the text and attachment seed together without changing other metadata', async () => {
    const result = await (await fork()).json() as ForkProjectResponse;
    const response = await fetch(`${base}/api/projects/${result.project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pendingPrompt: null }),
    });
    expect(response.status).toBe(200);
    const project = store.getProject(db, result.project.id)!;
    expect(project.pendingPrompt).toBeUndefined();
    expect(project.metadata).not.toHaveProperty('pendingAttachments');
    expect(project.metadata).not.toHaveProperty('pendingDraftConversationId');
    expect(project.metadata).toMatchObject({ fidelity: 'high-fidelity' });
  });

  it('resolves a new plugin snapshot with the same inputs and preserves the source pin', async () => {
    const folder = path.join(root, 'plugin');
    await mkdir(folder);
    await writeFile(path.join(folder, 'open-design.json'), JSON.stringify({
      name: 'brief-plugin', title: 'Brief plugin', version: '1.0.0',
      od: { kind: 'skill', taskKind: 'new-generation', useCase: { query: 'Make a {{topic}} brief.' },
        inputs: [{ name: 'topic', type: 'string', required: true, label: 'Topic' }], capabilities: ['prompt:inject'] },
    }));
    await writeFile(path.join(folder, 'SKILL.md'), '---\nname: brief-plugin\ndescription: Brief plugin\n---\nUse the uploaded assets.');
    const plugin = await resolvePluginFolder({ folder, folderId: 'brief-plugin', sourceKind: 'local', source: folder });
    if (!plugin.ok) throw new Error(plugin.errors.join('; '));
    upsertInstalledPlugin(db, plugin.record);
    const applied = resolvePluginSnapshot({ db, projectId: 'source', conversationId: 'source-chat',
      body: { pluginId: 'brief-plugin', pluginInputs: { topic: 'price list' }, grantCaps: ['prompt:inject'] },
      registry: { skills: [], designSystems: [], craft: [], atoms: [] },
    });
    expect(applied?.ok).toBe(true);
    if (!applied?.ok) throw new Error('fixture plugin did not apply');
    const response = await fork();
    expect(response.status).toBe(201);
    const result = await response.json() as ForkProjectResponse;
    expect(result.project.appliedPluginSnapshotId).toBeTruthy();
    expect(result.project.appliedPluginSnapshotId).not.toBe(applied.snapshotId);
    expect(getSnapshot(db, result.project.appliedPluginSnapshotId!)?.inputs).toEqual({ topic: 'price list' });
    expect(store.getProject(db, 'source')?.appliedPluginSnapshotId).toBe(applied.snapshotId);
    store.deleteProject(db, result.project.id);
    expect(getSnapshot(db, applied.snapshotId)).not.toBeNull();
  });

  it.each([
    { sourceConversationId: 'missing' }, { sourceMessageId: 'missing' },
    { sourceMessageId: 'reply' },
  ])('rejects missing or non-user source messages: %j', async (body) => {
    expect((await fork(body)).status).toBe(404);
    expect(store.listProjects(db)).toHaveLength(1);
  });

  it('rejects a conversation belonging to another project', async () => {
    store.insertProject(db, { id: 'other', name: 'Other', createdAt: 1, updatedAt: 1 });
    store.insertConversation(db, { id: 'other-chat', projectId: 'other', title: null, createdAt: 1, updatedAt: 1 });
    store.upsertMessage(db, 'other-chat', { id: 'other-message', role: 'user', content: 'private' });
    expect((await fork({ sourceConversationId: 'other-chat', sourceMessageId: 'other-message' })).status).toBe(404);
  });

  it('rolls back copied files when any attachment is missing', async () => {
    await rm(path.join(projectsRoot, 'source', 'logo.png'));
    const response = await fork();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'FORK_ATTACHMENT_UNAVAILABLE', details: { attachmentName: 'Logo.png' } } });
    expect(await readdir(projectsRoot)).toEqual(['source']);
    expect(store.listProjects(db)).toHaveLength(1);
  });

  it.each(['../secret', '/outside/secret'])('rejects paths outside the source: %s', async (attachmentPath) => {
    store.upsertMessage(db, 'source-chat', { id: 'brief', role: 'user', content: 'Brief', attachments: [{ path: attachmentPath, name: 'Secret', kind: 'file' }] });
    expect((await fork()).status).toBe(409);
    expect(await readdir(projectsRoot)).toEqual(['source']);
  });

  it('rejects symlinks escaping the source project', async () => {
    await writeFile(path.join(root, 'secret'), 'private');
    await rm(path.join(projectsRoot, 'source', 'logo.png'));
    await symlink(path.join(root, 'secret'), path.join(projectsRoot, 'source', 'logo.png'));
    expect((await fork()).status).toBe(409);
    expect(await readdir(projectsRoot)).toEqual(['source']);
  });

  it('rolls back the project transaction and files after a database failure', async () => {
    insertConversation = () => { throw new Error('simulated transaction failure'); };
    expect((await fork()).status).toBe(500);
    expect(store.listProjects(db)).toHaveLength(1);
    expect(await readdir(projectsRoot)).toEqual(['source']);
  });
});

it('normalizes legacy Windows absolute attachments without accepting sibling paths', () => {
  expect(forkAttachmentPath('C:\\Design\\Project', 'c:/Design/Project/assets/mark.png')).toBe('assets/mark.png');
  expect(() => forkAttachmentPath('C:\\Design\\Project', 'C:/Design/Project-other/secret')).toThrow();
});
