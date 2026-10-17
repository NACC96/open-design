import { describe, expect, it } from 'vitest';
import { getAgentDef } from '../../src/runtimes/registry.js';
import { sanitizeCustomModel } from '../../src/runtimes/models.js';
import {
  inheritedRunPrefsFromProjectExecution,
  parseProjectExecutionChoice,
  pickRunAgentId,
  resolveRunExecutionDefaults,
  snapshotRunExecution,
} from '../../src/projects/execution.js';

const deps = { getAgentDef, sanitizeCustomModel };

describe('parseProjectExecutionChoice', () => {
  it('treats null as clearing the stamp', () => {
    expect(parseProjectExecutionChoice(null, deps)).toEqual({ ok: true, value: null });
  });

  it('keeps only the keys that are present', () => {
    expect(parseProjectExecutionChoice({ agentId: 'codex' }, deps)).toEqual({
      ok: true,
      value: { agentId: 'codex' },
    });
    expect(parseProjectExecutionChoice({
      agentId: 'claude',
      model: 'claude-sonnet-4-6',
      reasoning: 'high',
      serviceTier: 'priority',
    }, deps)).toEqual({
      ok: true,
      value: { agentId: 'claude', model: 'claude-sonnet-4-6', reasoning: 'high', serviceTier: 'priority' },
    });
  });

  it('omits null prefs and a default service tier, and keeps a default model', () => {
    expect(parseProjectExecutionChoice({
      agentId: 'codex',
      model: 'default',
      reasoning: null,
      serviceTier: 'default',
    }, deps)).toEqual({ ok: true, value: { agentId: 'codex', model: 'default' } });
  });

  it.each([
    ['a non-object', 'codex'],
    ['an array', ['codex']],
    ['an unknown key', { agentId: 'codex', cwd: '/tmp' }],
    ['a missing agent id', { model: 'gpt-5' }],
    ['a malformed agent id', { agentId: '--help' }],
    ['the retired cloud runtime', { agentId: 'amr' }],
    ['the retired API-key runtime', { agentId: 'byok-opencode' }],
    ['an agent this build does not ship', { agentId: 'not-a-real-agent' }],
    ['a flag-shaped model', { agentId: 'claude', model: '--dangerously-skip-permissions' }],
    ['an empty model', { agentId: 'claude', model: '' }],
    ['a non-string model', { agentId: 'claude', model: 4 }],
    ['a reasoning level with spaces', { agentId: 'claude', reasoning: 'very high' }],
    ['a flag-shaped service tier', { agentId: 'codex', serviceTier: '-fast' }],
  ])('rejects %s', (_label, raw) => {
    const result = parseProjectExecutionChoice(raw, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^execution/);
  });

  it('does not require the agent to be installed', () => {
    // Availability is a run-time condition; a project may name a CLI this
    // machine has not installed yet.
    expect(parseProjectExecutionChoice({ agentId: 'aider' }, deps)).toEqual({
      ok: true,
      value: { agentId: 'aider' },
    });
  });
});

describe('pickRunAgentId', () => {
  const agents = [
    { id: 'claude', available: true },
    { id: 'codex', available: true },
    { id: 'aider', available: false },
  ];

  it('prefers the project stamp when it is available', () => {
    expect(pickRunAgentId({ stampedAgentId: 'codex', configuredAgentId: 'claude', agents }))
      .toEqual({ agentId: 'codex', source: 'project' });
  });

  it('falls back to the configured agent and names the unused stamp', () => {
    expect(pickRunAgentId({ stampedAgentId: 'aider', configuredAgentId: 'codex', agents }))
      .toEqual({ agentId: 'codex', source: 'app-config', projectAgentId: 'aider' });
  });

  it('falls back to the first available agent and names the unused stamp', () => {
    expect(pickRunAgentId({ stampedAgentId: 'aider', configuredAgentId: 'aider', agents }))
      .toEqual({ agentId: 'claude', source: 'first-available', projectAgentId: 'aider' });
  });

  it('keeps today\'s order for unstamped projects', () => {
    expect(pickRunAgentId({ stampedAgentId: null, configuredAgentId: 'codex', agents }))
      .toEqual({ agentId: 'codex', source: 'app-config' });
    expect(pickRunAgentId({ configuredAgentId: null, agents }))
      .toEqual({ agentId: 'claude', source: 'first-available' });
  });

  it('reports no agent when nothing is installed', () => {
    expect(pickRunAgentId({
      stampedAgentId: 'codex',
      configuredAgentId: 'claude',
      agents: [{ id: 'claude', available: false }],
    })).toEqual({ agentId: null, source: 'first-available', projectAgentId: 'codex' });
  });
});

describe('resolveRunExecutionDefaults', () => {
  const appConfig = {
    agentModels: { codex: { model: 'gpt-5-global', reasoning: 'low' }, claude: { model: 'claude-global' } },
  };

  it('uses the stamp, not the global model, when the stamp governs the agent', () => {
    expect(resolveRunExecutionDefaults('codex', {
      execution: { agentId: 'codex', model: 'gpt-5-codex', reasoning: 'high', serviceTier: 'priority' },
    }, appConfig)).toEqual({
      source: 'project',
      model: 'gpt-5-codex',
      reasoning: 'high',
      serviceTier: 'priority',
    });
  });

  it('returns no model for a stamp without one, never the global model', () => {
    expect(resolveRunExecutionDefaults('codex', { execution: { agentId: 'codex' } }, appConfig)).toEqual({
      source: 'project',
      model: null,
      reasoning: null,
      serviceTier: null,
    });
  });

  it('keeps today\'s app-config model for unstamped projects and other agents', () => {
    const appConfigDefaults = { source: 'app-config', model: 'claude-global', reasoning: null, serviceTier: null };
    expect(resolveRunExecutionDefaults('claude', null, appConfig)).toEqual(appConfigDefaults);
    expect(resolveRunExecutionDefaults('claude', {}, appConfig)).toEqual(appConfigDefaults);
    expect(resolveRunExecutionDefaults('claude', { execution: { agentId: 'codex', model: 'x' } }, appConfig))
      .toEqual(appConfigDefaults);
    expect(resolveRunExecutionDefaults('pi', null, appConfig)).toEqual({
      source: 'app-config', model: null, reasoning: null, serviceTier: null,
    });
  });
});

describe('inheritedRunPrefsFromProjectExecution', () => {
  const project = { execution: { agentId: 'codex', model: 'gpt-5-codex', reasoning: 'high', serviceTier: 'priority' } };

  it('fills what the request left out when the run uses the stamp model', () => {
    expect(inheritedRunPrefsFromProjectExecution('codex', project, {}))
      .toEqual({ reasoning: 'high', serviceTier: 'priority' });
    expect(inheritedRunPrefsFromProjectExecution('codex', project, { model: 'gpt-5-codex', reasoning: 'low' }))
      .toEqual({ serviceTier: 'priority' });
  });

  it('inherits nothing onto a model the request chose explicitly', () => {
    expect(inheritedRunPrefsFromProjectExecution('codex', project, { model: 'gpt-5' })).toEqual({});
  });

  it('inherits nothing for another agent or an unstamped project', () => {
    expect(inheritedRunPrefsFromProjectExecution('claude', project, {})).toEqual({});
    expect(inheritedRunPrefsFromProjectExecution('codex', null, {})).toEqual({});
  });

  it('treats a default model request as the model-less stamp', () => {
    expect(inheritedRunPrefsFromProjectExecution(
      'claude',
      { execution: { agentId: 'claude', reasoning: 'max' } },
      { model: 'default' },
    )).toEqual({ reasoning: 'max' });
  });
});

describe('accepted run execution snapshot', () => {
  it('pins project model, reasoning and tier independently from later edits', () => {
    const project = { execution: { agentId: 'codex', model: 'astra', reasoning: 'high', serviceTier: 'priority' } };
    const snapshot = snapshotRunExecution('codex', project, {}, {});
    project.execution.model = 'sol';
    expect(snapshot).toEqual({ agentId: 'codex', model: 'astra', reasoning: 'high', serviceTier: 'priority' });
  });
  it('pins CLI default explicitly and drops incompatible inherited options', () => {
    expect(snapshotRunExecution('claude', { execution: { agentId: 'claude' } }, { agentModels: { claude: { model: 'opus' } } }, {})).toEqual({ agentId: 'claude', model: 'default' });
    expect(snapshotRunExecution('codex', { execution: { agentId: 'codex', model: 'astra', reasoning: 'high' } }, {}, { model: 'sol' })).toEqual({ agentId: 'codex', model: 'sol' });
  });
});
