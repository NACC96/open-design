// @vitest-environment jsdom
//
// Home composer chip → installed-CLI tabs. Switching CLI used to require
// Settings → Execution; the compact popover now leads with one tab per
// installed local CLI, and the model list + effort select below follow the
// selected tab.
//
// As in the compact-click spec, the switcher does not own persistence — App
// does — so the wrapper mirrors `App.handleAgentChange` /
// `handleAgentModelChange` and feeds the next config back in as a prop. The
// assertions read what the user sees after that round-trip.

import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentModelChoice } from '../../src/App';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

const baseConfig: AppConfig = {
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
  agentModels: { claude: { model: 'claude-opus-5-5' } },
  agentCliEnv: {},
};

const claudeAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.1.300',
  models: [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  ],
  reasoningOptions: [
    { id: 'default', label: 'CLI default' },
    { id: 'high', label: 'High' },
  ],
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '0.140.0',
  models: [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'gpt-6.1', label: 'gpt-6.1' },
  ],
};

const uninstalledAgent: AgentInfo = {
  id: 'gemini',
  name: 'Gemini CLI',
  bin: 'gemini',
  available: false,
  models: [{ id: 'default', label: 'Default (CLI config)' }],
};

function StatefulSwitcher({
  agents,
  onAgentChange,
}: {
  agents: AgentInfo[];
  onAgentChange?: (agentId: string) => void;
}) {
  const [config, setConfig] = useState<AppConfig>(baseConfig);
  const persistedRef = useRef(config);
  const commit = (next: AppConfig) => {
    persistedRef.current = next;
    setConfig(next);
  };
  return (
    <InlineModelSwitcher
      config={config}
      agents={agents}
      providerModelsCache={{}}
      compact
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={(agentId) => {
        onAgentChange?.(agentId);
        commit({ ...persistedRef.current, agentId });
      }}
      onAgentModelChange={(agentId, choice) => {
        const current = persistedRef.current;
        commit({
          ...current,
          agentModels: {
            ...(current.agentModels ?? {}),
            [agentId]: mergeAgentModelChoice(current.agentModels?.[agentId] ?? {}, choice),
          },
        });
      }}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
}

function openSwitcher(): HTMLElement {
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return screen.getByTestId('inline-model-switcher-popover');
}

function tab(agentId: string): HTMLElement {
  return screen.getByTestId(`inline-model-switcher-agent-tab-${agentId}`);
}

describe('InlineModelSwitcher compact popover — CLI tabs', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('leads with one tab per installed CLI, above the model list', () => {
    render(<StatefulSwitcher agents={[claudeAgent, codexAgent, uninstalledAgent]} />);
    const popover = openSwitcher();

    const tabs = screen.getByTestId('inline-model-switcher-agent-tab');
    expect(within(tabs).getAllByRole('radio').map((node) => node.dataset.testid)).toEqual([
      'inline-model-switcher-agent-tab-claude',
      'inline-model-switcher-agent-tab-codex',
    ]);
    expect(tab('claude').getAttribute('aria-checked')).toBe('true');
    // An uninstalled CLI cannot run, so it is not offered.
    expect(screen.queryByTestId('inline-model-switcher-agent-tab-gemini')).toBeNull();

    const modelRow = screen.getByTestId('inline-model-switcher-compact-model-claude-opus-5-5');
    // DOCUMENT_POSITION_FOLLOWING: the model list comes after the tabs.
    expect(tabs.compareDocumentPosition(modelRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(popover.contains(tabs)).toBe(true);
  });

  it('switches CLI in place: the list, effort and chip follow the new tab', () => {
    const onAgentChange = vi.fn();
    render(
      <StatefulSwitcher agents={[claudeAgent, codexAgent]} onAgentChange={onAgentChange} />,
    );
    openSwitcher();
    expect(screen.getByTestId('inline-model-switcher-reasoning')).toBeTruthy();

    fireEvent.click(tab('codex'));

    expect(onAgentChange).toHaveBeenCalledWith('codex');
    // The popover stays open so a model can be picked for the new CLI.
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();
    expect(tab('codex').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('inline-model-switcher-compact-model-gpt-6.1')).toBeTruthy();
    expect(screen.queryByTestId('inline-model-switcher-compact-model-claude-opus-5-5')).toBeNull();
    // Codex publishes no effort options, so Claude's select goes away.
    expect(screen.queryByTestId('inline-model-switcher-reasoning')).toBeNull();

    fireEvent.click(screen.getByTestId('inline-model-switcher-compact-model-gpt-6.1'));
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(screen.getByTestId('inline-model-switcher-chip').textContent).toContain('gpt-6.1');
  });

  it('does not report a switch when the active tab is clicked again', () => {
    const onAgentChange = vi.fn();
    render(
      <StatefulSwitcher agents={[claudeAgent, codexAgent]} onAgentChange={onAgentChange} />,
    );
    openSwitcher();
    fireEvent.click(tab('claude'));
    expect(onAgentChange).not.toHaveBeenCalled();
  });

  it('says so when no CLI is installed', () => {
    render(<StatefulSwitcher agents={[uninstalledAgent]} />);
    const popover = openSwitcher();
    expect(screen.queryByTestId('inline-model-switcher-agent-tab')).toBeNull();
    expect(popover.textContent).toMatch(/No CLI detected/i);
  });
});
