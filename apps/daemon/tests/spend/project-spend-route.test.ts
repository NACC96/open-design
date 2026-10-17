import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfigResponse, ProjectSpendResponse } from '@open-design/contracts';

import { startServer } from '../../src/server.js';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { recordRunUsageEvent } from '../../src/spend/run-usage-recorder.js';

describe('GET /api/projects/:id/spend', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectId = 'proj-spend-route';

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;

    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: projectId }),
    });
    expect(created.status).toBe(200);

    const dataDir = process.env.OD_DATA_DIR!;
    const db = openDatabase(dataDir, { dataDir });
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('conv-spend-route', projectId, 'Hero section', now, now);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, position, created_at)
       VALUES (?, ?, 'assistant', '', 0, ?)`,
    ).run('msg-spend-route', 'conv-spend-route', now);
    const run = { id: 'run-spend-route', assistantMessageId: 'msg-spend-route', agentId: 'codex', launchModel: 'gpt-5.4' };
    recordRunUsageEvent(db, run, 'start', {});
    recordRunUsageEvent(db, run, 'agent', {
      type: 'usage',
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  it('returns the project total priced from the bundled table', async () => {
    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/spend`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as ProjectSpendResponse;
    expect(body).toMatchObject({ projectId, currency: 'USD' });
    expect(body.priceTableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // gpt-5.4: 1M input at $2.50 + 100K output at $15.
    expect(body.total.costUsd).toBeCloseTo(4, 10);
    expect(body.byConversation[0]).toMatchObject({ title: 'Hero section', turns: 1 });
  });

  it('re-prices history when a model price override is saved', async () => {
    const put = await fetch(`${baseUrl}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelPriceOverrides: {
          'gpt-5.4': { input: 1, output: 10 },
          'bad-entry': { input: 'free' },
        },
      }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as AppConfigResponse;
    expect(saved.config.modelPriceOverrides).toEqual({ 'gpt-5.4': { input: 1, output: 10 } });

    const body = (await (await fetch(`${baseUrl}/api/projects/${projectId}/spend`)).json()) as ProjectSpendResponse;
    expect(body.total.costUsd).toBeCloseTo(2, 10);
    expect(body.byModel[0]).toMatchObject({ model: 'gpt-5.4', priceSource: 'override' });
  });

  it('404s for an unknown project', async () => {
    const resp = await fetch(`${baseUrl}/api/projects/no-such-project/spend`);
    expect(resp.status).toBe(404);
  });
});
