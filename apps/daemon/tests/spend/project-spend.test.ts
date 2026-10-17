import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertAgentSession,
  upsertMessage,
} from '../../src/db.js';
import { computeProjectSpend } from '../../src/spend/project-spend.js';
import { recordRunUsageEvent, type RunUsageRunState } from '../../src/spend/run-usage-recorder.js';
import { inheritedRunUsageRecord, insertBackfilledRunUsage } from '../../src/spend/run-usage-store.js';

describe('project spend', () => {
  let tempDir: string;
  let runsLogDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-project-spend-'));
    runsLogDir = path.join(tempDir, 'runs');
    mkdirSync(runsLogDir, { recursive: true });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertProject(db, { id: 'proj-2', name: 'Other', createdAt: now, updatedAt: now });
    for (const [id, projectId, title] of [
      ['conv-1', 'proj-1', 'Landing page'],
      ['conv-2', 'proj-1', 'Pricing table'],
      ['conv-other', 'proj-2', 'Elsewhere'],
    ] as const) {
      insertConversation(db, { id, projectId, title, createdAt: now, updatedAt: now });
    }
    return db;
  }

  function assistant(db: ReturnType<typeof seed>, conversationId: string, id: string, extra: Record<string, unknown> = {}) {
    upsertMessage(db, conversationId, { id, role: 'assistant', content: `reply ${id}`, ...extra });
  }

  function liveRun(db: ReturnType<typeof seed>, run: RunUsageRunState, events: Array<[string, unknown]>) {
    for (const [event, data] of events) recordRunUsageEvent(db, run, event, data);
  }

  const claudeTurn: Array<[string, unknown]> = [
    ['start', {}],
    ['agent', { type: 'status', label: 'initializing', model: 'claude-sonnet-4-5-20250929' }],
    ['agent', { type: 'text_delta', delta: 'hello' }],
    ['agent', {
      type: 'usage',
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 4000,
        cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 1000 },
      },
      // The resumed session's running total, not this turn's cost.
      costUsd: 12.5,
      costScope: 'session_cumulative',
    }],
  ];
  // claude-sonnet-4-5 ($3 in / $15 out / $0.30 cache read / $3.75 5-minute and
  // $6 one-hour cache write): 1K in + 2K out + 10K read + 1K 5m + 3K 1h writes.
  const claudeTurnCost = (1000 * 3 + 2000 * 15 + 10_000 * 0.3 + 1000 * 3.75 + 3000 * 6) / 1_000_000;

  const codexTurn: Array<[string, unknown]> = [
    ['start', {}],
    ['agent', {
      type: 'usage',
      usageScope: 'sessionCumulative',
      usage: { input_tokens: 9_000_000, output_tokens: 9_000_000 },
      turnTokenUsage: { input: 1_000_000, cachedInput: 800_000, cacheWrite: 0, output: 100_000, reasoning: 20_000 },
    }],
  ];

  it('prices live-recorded turns and rolls them up by model and conversation', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-claude');
    assistant(db, 'conv-2', 'msg-codex');
    assistant(db, 'conv-other', 'msg-other');
    liveRun(db, { id: 'run-claude', assistantMessageId: 'msg-claude', agentId: 'claude', model: 'default' }, claudeTurn);
    liveRun(db, { id: 'run-codex', assistantMessageId: 'msg-codex', agentId: 'codex', model: 'gpt-5.5', launchModel: 'gpt-5.5' }, codexTurn);
    liveRun(db, { id: 'run-other', assistantMessageId: 'msg-other', agentId: 'claude' }, claudeTurn);

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir, now: 42 });

    // Codex at gpt-5.5 ($5 in / $0.50 cached / $30 out): 200K uncached + 800K cached + 100K out.
    const codexCost = 0.2 * 5 + 0.8 * 0.5 + 0.1 * 30;
    expect(spend.total.turns).toBe(2);
    expect(spend.total.pricedTurns).toBe(2);
    expect(spend.total.reportedTurns).toBe(0);
    expect(spend.total.costUsd).toBeCloseTo(claudeTurnCost + codexCost, 10);
    expect(spend.total.tokens).toEqual({ input: 201_000, output: 102_000, cacheRead: 810_000, cacheWrite: 4000 });
    expect(spend.generatedAt).toBe(42);

    expect(spend.byModel.map((row) => [row.model, row.agentIds, row.priceSource])).toEqual([
      ['gpt-5.5', ['codex'], 'bundled'],
      ['claude-sonnet-4-5', ['claude'], 'bundled'],
    ]);
    expect(spend.byConversation.map((row) => [row.title, row.turns])).toEqual([
      ['Pricing table', 1],
      ['Landing page', 1],
    ]);
  });

  it('prices Claude turns from their own tokens across a resumed session', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-1');
    assistant(db, 'conv-1', 'msg-2');
    const run = (sessionTotal: number): Array<[string, unknown]> => [
      ['start', {}],
      ['agent', { type: 'status', label: 'initializing', model: 'claude-sonnet-4-5' }],
      ['agent', { ...(claudeTurn[3]![1] as Record<string, unknown>), costUsd: sessionTotal }],
    ];
    // The second run resumes the first's session, so its reported total includes the first run.
    liveRun(db, { id: 'run-1', assistantMessageId: 'msg-1', agentId: 'claude' }, run(0.06));
    liveRun(db, { id: 'run-2', assistantMessageId: 'msg-2', agentId: 'claude' }, run(0.12));

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total).toMatchObject({ turns: 2, pricedTurns: 2, reportedTurns: 0, estimatedTurns: 0 });
    expect(spend.total.costUsd).toBeCloseTo(2 * claudeTurnCost, 10);
    expect(spend.byModel[0]).toMatchObject({ model: 'claude-sonnet-4-5', priceSource: 'bundled' });
  });

  it('applies a price override to every turn priced from tokens, but not to a cost the agent reported', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-claude');
    assistant(db, 'conv-2', 'msg-codex');
    assistant(db, 'conv-2', 'msg-opencode');
    liveRun(db, { id: 'run-claude', assistantMessageId: 'msg-claude', agentId: 'claude' }, claudeTurn);
    liveRun(db, { id: 'run-codex', assistantMessageId: 'msg-codex', agentId: 'codex', launchModel: 'gpt-5.5' }, codexTurn);
    liveRun(db, { id: 'run-opencode', assistantMessageId: 'msg-opencode', agentId: 'opencode', launchModel: 'openai/gpt-5.4' }, [
      ['agent', { type: 'usage', usage: { input_tokens: 1000, output_tokens: 100 }, costUsd: 0.07 }],
    ]);

    const spend = await computeProjectSpend(db, 'proj-1', {
      runsLogDir,
      overrides: {
        'claude-sonnet-4-5': { input: 1, output: 1, cacheRead: 0 },
        'openai/gpt-5.5': { input: 1, output: 10, cacheRead: 0.1 },
        'gpt-5.4': { input: 100, output: 100 },
      },
    });
    // No cacheWrite rate: 5-minute writes bill at input, one-hour writes at twice input.
    const claude = spend.byModel.find((row) => row.model === 'claude-sonnet-4-5');
    expect(claude).toMatchObject({ priceSource: 'override', reportedTurns: 0 });
    expect(claude?.costUsd).toBeCloseTo((1000 + 2000 + 1000 + 3000 * 2) / 1_000_000, 12);
    const codex = spend.byModel.find((row) => row.model === 'gpt-5.5');
    expect(codex?.priceSource).toBe('override');
    expect(codex?.costUsd).toBeCloseTo(0.2 * 1 + 0.8 * 0.1 + 0.1 * 10, 10);
    expect(spend.byModel.find((row) => row.model === 'gpt-5.4')).toMatchObject({ reportedTurns: 1, costUsd: 0.07 });
  });

  it('prices AMR turns at the catalog price frozen at launch', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-amr');
    liveRun(db, {
      id: 'run-amr',
      assistantMessageId: 'msg-amr',
      agentId: 'amr',
      launchModel: 'deepseek-v4-pro',
      launchModelPrice: { input: 2, output: 8 },
    }, [
      ['start', {}],
      ['agent', { type: 'status', label: 'model', model: 'public_model_deepseek_v4_pro' }],
      ['agent', { type: 'usage', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }],
    ]);
    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total.costUsd).toBeCloseTo(10, 10);
    expect(spend.byModel[0]).toMatchObject({ model: 'deepseek-v4-pro', priceSource: 'catalog' });
  });

  it('keeps the catalog price when the agent reports the launch model under a table-known id', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-amr');
    liveRun(db, {
      id: 'run-amr',
      assistantMessageId: 'msg-amr',
      agentId: 'amr',
      launchModel: 'deepseek-v4-pro',
      launchModelPrice: { input: 2, output: 8 },
    }, [
      ['agent', { type: 'status', label: 'model', model: 'vela/deepseek-v4-pro' }],
      ['agent', { type: 'usage', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }],
    ]);
    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.byModel[0]).toMatchObject({ model: 'deepseek-v4-pro', priceSource: 'catalog' });
    expect(spend.total.costUsd).toBeCloseTo(10, 10);
  });

  it('counts unknown models as unpriced instead of guessing', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-local');
    liveRun(db, { id: 'run-local', assistantMessageId: 'msg-local', agentId: 'opencode', launchModel: 'ollama/my-llama' }, [
      ['agent', { type: 'usage', usage: { input_tokens: 500, output_tokens: 50 } }],
    ]);
    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total).toMatchObject({ turns: 1, pricedTurns: 0, unpricedTurns: 1, costUsd: 0 });
    expect(spend.byModel[0]).toMatchObject({ model: 'my-llama', price: null, priceSource: null });
  });

  it('skips turns that never consumed tokens', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-failed');
    liveRun(db, { id: 'run-failed', assistantMessageId: 'msg-failed', agentId: 'claude' }, [['start', {}]]);
    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total.turns).toBe(0);
    expect(spend.byModel).toEqual([]);
  });

  it('backfills older turns by replaying their durable run log', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-old', { runId: 'run-old', agentId: 'codex' });
    const runDir = path.join(runsLogDir, 'run-old');
    mkdirSync(runDir);
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: 'run-old', agentId: 'codex', model: 'default', resolvedModelId: 'gpt-5.4' }));
    writeFileSync(path.join(runDir, 'events.jsonl'), [...codexTurn.map(([event, data], i) => JSON.stringify({ id: i + 1, event, data })), '{"torn'].join('\n'));

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total).toMatchObject({ turns: 1, pricedTurns: 1, estimatedTurns: 0 });
    // gpt-5.4: $2.50 in / $0.25 cached / $15 out.
    expect(spend.total.costUsd).toBeCloseTo(0.2 * 2.5 + 0.8 * 0.25 + 0.1 * 15, 10);
    expect(spend.byModel[0]?.model).toBe('gpt-5.4');

    // The backfill is recorded once; a second read does not double count.
    const again = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(again.total.turns).toBe(1);
  });

  it('prices a replayed Claude log from its tokens even before usage carried a cost scope', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-old', { runId: 'run-old', agentId: 'claude' });
    const runDir = path.join(runsLogDir, 'run-old');
    mkdirSync(runDir);
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: 'run-old', agentId: 'claude', model: 'default' }));
    const unmarked = claudeTurn.map(([event, data]) => {
      if ((data as { type?: string }).type !== 'usage') return [event, data];
      const { costScope: _scope, ...rest } = data as Record<string, unknown>;
      return [event, rest];
    });
    writeFileSync(path.join(runDir, 'events.jsonl'), unmarked.map(([event, data], i) => JSON.stringify({ id: i + 1, event, data })).join('\n'));

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total).toMatchObject({ turns: 1, pricedTurns: 1, reportedTurns: 0 });
    expect(spend.total.costUsd).toBeCloseTo(claudeTurnCost, 10);
  });

  it('reconstructs turns without a run log from persisted message events, flagged estimated', async () => {
    const db = seed();
    // Two Codex turns on one resumed thread: persisted usage is the running thread total.
    assistant(db, 'conv-1', 'msg-a', { agentId: 'codex', events: [{ kind: 'usage', inputTokens: 1000, outputTokens: 100 }] });
    assistant(db, 'conv-1', 'msg-b', { agentId: 'codex', events: [
      { kind: 'usage', inputTokens: 1200, outputTokens: 120 },
      { kind: 'usage', inputTokens: 1500, outputTokens: 150 },
    ] });
    // A Claude turn whose model came from its init status and whose cost was reported.
    assistant(db, 'conv-2', 'msg-c', { agentId: 'claude', events: [
      { kind: 'status', label: 'initializing', detail: 'claude-opus-4-6' },
      { kind: 'text', text: 'done' },
      { kind: 'usage', inputTokens: 10, outputTokens: 20, costUsd: 0.25 },
    ] });
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'codex', sessionId: 's', model: 'gpt-5.1' });

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total).toMatchObject({ turns: 3, pricedTurns: 3, estimatedTurns: 3, reportedTurns: 1 });
    const codex = spend.byModel.find((row) => row.model === 'gpt-5.1');
    // 1000 + (1500 - 1000) input, 100 + (150 - 100) output at $1.25 / $10.
    expect(codex?.tokens).toMatchObject({ input: 1500, output: 150 });
    expect(codex?.costUsd).toBeCloseTo((1500 * 1.25 + 150 * 10) / 1_000_000, 12);
    expect(spend.byModel.find((row) => row.model === 'claude-opus-4-6')?.costUsd).toBeCloseTo(0.25, 10);
  });

  it('does not count a fork\'s copies of the source conversation\'s turns again', async () => {
    const db = seed();
    const turn = [{ kind: 'usage', inputTokens: 100, outputTokens: 10, costUsd: 0.1 }];
    assistant(db, 'conv-1', 'msg-source', { agentId: 'opencode', events: turn });
    // A fork from before the fork route recorded its copies: recognized by the
    // boundary on the last message it copied. Its own later turn still counts.
    assistant(db, 'conv-2', 'msg-copy', {
      agentId: 'opencode',
      events: turn,
      forkedInto: { title: 'Landing page', conversationId: 'conv-1' },
    });
    assistant(db, 'conv-2', 'msg-after-fork', { agentId: 'opencode', events: [{ kind: 'usage', inputTokens: 50, outputTokens: 5, costUsd: 0.05 }] });
    // A fork the route recorded: an untitled source leaves no boundary.
    insertConversation(db, { id: 'conv-3', projectId: 'proj-1', title: null, createdAt: Date.now(), updatedAt: Date.now() });
    assistant(db, 'conv-3', 'msg-copy-untitled', { agentId: 'opencode', events: turn });
    insertBackfilledRunUsage(db, [inheritedRunUsageRecord('msg-copy-untitled', 'opencode')]);
    // An older fork of an untitled conversation: no boundary and no row, but
    // the copy keeps its source's text and creation time.
    assistant(db, 'conv-1', 'msg-untitled-source', { agentId: 'opencode', events: turn, content: 'done', createdAt: 1_700_000_000_000 });
    insertConversation(db, { id: 'conv-4', projectId: 'proj-1', title: null, createdAt: Date.now(), updatedAt: Date.now() });
    assistant(db, 'conv-4', 'msg-old-untitled-copy', { agentId: 'opencode', events: turn, content: 'done', createdAt: 1_700_000_000_000 });

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total).toMatchObject({ turns: 3, reportedTurns: 3 });
    expect(spend.total.costUsd).toBeCloseTo(0.25, 10);
    expect(spend.byConversation.map((row) => row.conversationId).sort()).toEqual(['conv-1', 'conv-2']);
  });

  it('prices each resumed Codex exec run by its growth over the session\'s previous run', async () => {
    const db = seed();
    const execRun = (sessionId: string, input: number, cached: number, output: number): Array<[string, unknown]> => [
      ['start', {}],
      ['agent', { type: 'status', label: 'initializing', sessionId }],
      // `turn.completed` usage: the thread's running total, with no scope.
      ['agent', { type: 'usage', usage: { input_tokens: input, cached_read_tokens: cached, output_tokens: output } }],
    ];
    const run = (id: string, messageId: string): RunUsageRunState =>
      ({ id, assistantMessageId: messageId, agentId: 'codex', model: 'gpt-5.5', launchModel: 'gpt-5.5' });
    for (const id of ['msg-1', 'msg-2', 'msg-3']) assistant(db, 'conv-1', id, { agentId: 'codex' });
    liveRun(db, run('run-1', 'msg-1'), execRun('th-1', 10_000, 6_000, 100));
    liveRun(db, run('run-2', 'msg-2'), execRun('th-1', 30_000, 20_000, 300));
    // A new thread: its total is all its own, even though it is larger.
    liveRun(db, run('run-3', 'msg-3'), execRun('th-2', 40_000, 0, 50));

    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total.turns).toBe(3);
    // Uncached 4K + 6K + 40K, cached 6K + 14K, output 100 + 200 + 50.
    expect(spend.total.tokens).toEqual({ input: 50_000, output: 350, cacheRead: 20_000, cacheWrite: 0 });
    expect(spend.total.estimatedTurns).toBe(0);
  });

  it('drops a conversation\'s spend with the conversation', async () => {
    const db = seed();
    assistant(db, 'conv-1', 'msg-claude');
    liveRun(db, { id: 'run-claude', assistantMessageId: 'msg-claude', agentId: 'claude' }, claudeTurn);
    db.prepare('DELETE FROM conversations WHERE id = ?').run('conv-1');
    const spend = await computeProjectSpend(db, 'proj-1', { runsLogDir });
    expect(spend.total.turns).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_usage').get()).toEqual({ n: 0 });
  });
});
