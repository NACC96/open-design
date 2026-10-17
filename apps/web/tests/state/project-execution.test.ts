import { describe, expect, it } from 'vitest';

import {
  effectiveProjectExecution,
  nextProjectExecutionForAgent,
  nextProjectExecutionForChoice,
  projectExecutionFromConfig,
  projectRunConfig,
  sameProjectExecution,
  toProjectExecution,
  withProjectExecution,
} from '../../src/state/project-execution';
import type { AgentInfo, AppConfig, ChatMessage } from '../../src/types';

const globalConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'claude',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {
    claude: { model: 'claude-opus-5-5', reasoning: 'high' },
    codex: { model: 'gpt-6.1', reasoning: 'xhigh', serviceTier: 'fast' },
  },
  agentCliEnv: {},
};

const agents: AgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    models: [{ id: 'default', label: 'Default' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }],
    reasoningOptions: [{ id: 'default', label: 'CLI default' }, { id: 'high', label: 'High' }],
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    available: true,
    models: [
      { id: 'default', label: 'Default' },
      {
        id: 'gpt-6.1',
        label: 'gpt-6.1',
        reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
        serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
      },
    ],
  },
];

describe('project execution stamp helpers', () => {
  it('reads the app-config default as a stamp', () => {
    expect(projectExecutionFromConfig(globalConfig)).toEqual({
      agentId: 'claude',
      model: 'claude-opus-5-5',
      reasoning: 'high',
    });
    expect(projectExecutionFromConfig({ ...globalConfig, agentId: null })).toBeNull();
    // Retired runtimes cannot be stamped onto a project.
    expect(projectExecutionFromConfig({ ...globalConfig, agentId: 'amr' })).toBeNull();
  });

  it('keeps only the keys that are set', () => {
    expect(toProjectExecution('codex', { model: '', reasoning: undefined })).toEqual({
      agentId: 'codex',
    });
  });

  it('prefers the project stamp and falls back to the global default for legacy projects', () => {
    const stamp = { agentId: 'codex', model: 'gpt-6.1' };
    expect(effectiveProjectExecution(stamp, globalConfig)).toBe(stamp);
    expect(effectiveProjectExecution(null, globalConfig)).toEqual({
      agentId: 'claude',
      model: 'claude-opus-5-5',
      reasoning: 'high',
    });
    // A stamp naming a retired runtime is treated as no stamp.
    expect(effectiveProjectExecution({ agentId: 'amr' }, globalConfig)?.agentId).toBe('claude');
  });

  it('overrides the agent slot exactly, without merging global prefs', () => {
    const scoped = withProjectExecution(globalConfig, { agentId: 'codex', model: 'gpt-6.1' });
    expect(scoped.agentId).toBe('codex');
    // The global codex effort + tier must not bleed into a project that picked none.
    expect(scoped.agentModels?.codex).toEqual({ model: 'gpt-6.1' });
    // Other agents' slots are untouched.
    expect(scoped.agentModels?.claude).toEqual(globalConfig.agentModels?.claude);
  });

  it('keeps config identity when the project already matches the default', () => {
    expect(withProjectExecution(globalConfig, projectExecutionFromConfig(globalConfig))).toBe(
      globalConfig,
    );
    expect(withProjectExecution(globalConfig, null)).toBe(globalConfig);
  });

  it('seeds a CLI switch from the global slot and drops effort/tier the model lacks', () => {
    // codex's global effort `xhigh` is not offered by gpt-6.1; `fast` is.
    expect(
      nextProjectExecutionForAgent(
        { agentId: 'claude', model: 'claude-opus-5-5' },
        'codex',
        globalConfig,
        agents,
      ),
    ).toEqual({ agentId: 'codex', model: 'gpt-6.1', serviceTier: 'fast' });
  });

  it('keeps the current choice when the same CLI is picked', () => {
    const current = { agentId: 'claude', model: 'default' };
    expect(nextProjectExecutionForAgent(current, 'claude', globalConfig, agents)).toBe(current);
  });

  it('merges model / effort patches like the global writer', () => {
    const current = { agentId: 'claude', model: 'claude-opus-5-5', reasoning: 'high' };
    expect(nextProjectExecutionForChoice(current, 'claude', { reasoning: 'default' })).toEqual({
      agentId: 'claude',
      model: 'claude-opus-5-5',
      reasoning: 'default',
    });
    // An own `undefined` clears.
    expect(
      nextProjectExecutionForChoice(current, 'claude', { model: 'default', reasoning: undefined }),
    ).toEqual({ agentId: 'claude', model: 'default' });
    // A patch for another agent starts from that agent, not from this stamp.
    expect(nextProjectExecutionForChoice(current, 'codex', { model: 'gpt-6.1' })).toEqual({
      agentId: 'codex',
      model: 'gpt-6.1',
    });
  });

  it('compares stamps by value', () => {
    expect(sameProjectExecution({ agentId: 'codex' }, { agentId: 'codex', model: undefined })).toBe(
      true,
    );
    expect(sameProjectExecution({ agentId: 'codex' }, { agentId: 'claude' })).toBe(false);
    expect(sameProjectExecution(null, undefined)).toBe(true);
  });

  it('keeps an OD Next clarification answer on the agent that asked', () => {
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        agentId: 'claude',
        strategyTaskExecutionId: 'task-1',
      },
    ] as ChatMessage[];
    const switched = { agentId: 'codex', model: 'gpt-6.1' };

    const answer = projectRunConfig(globalConfig, switched, 'task-1', messages);
    expect(answer.agentId).toBe('claude');
    expect(answer.agentModels?.claude).toEqual({ model: 'claude-opus-5-5', reasoning: 'high' });

    // A fresh turn uses the project's new CLI.
    expect(projectRunConfig(globalConfig, switched, undefined, messages).agentId).toBe('codex');
  });
});
