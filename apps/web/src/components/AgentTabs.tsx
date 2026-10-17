// AgentTabs — one-click switch between the installed local agent CLIs.
//
// Shared by the Home composer's execution popover (where a pick becomes the
// default for new projects) and the project composer's popover (where a pick
// changes only that project). The component only draws and reports; what a
// selection writes is the caller's decision.

import type { AgentInfo } from '../types';
import { AgentIcon } from './AgentIcon';
import styles from './AgentTabs.module.css';

interface Props {
  agents: ReadonlyArray<Pick<AgentInfo, 'id' | 'name' | 'version'>>;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  ariaLabel: string;
  testIdPrefix: string;
}

function agentDisplayName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'OpenDesign' : agent.name;
}

export function AgentTabs({
  agents,
  selectedId,
  onSelect,
  ariaLabel,
  testIdPrefix,
}: Props) {
  if (agents.length === 0) return null;
  return (
    <div
      className={styles.tabs}
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testIdPrefix}
    >
      {agents.map((agent) => {
        const active = agent.id === selectedId;
        const name = agentDisplayName(agent);
        return (
          <button
            key={agent.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={styles.tab}
            data-testid={`${testIdPrefix}-${agent.id}`}
            title={agent.version ? `${name} · ${agent.version}` : name}
            onClick={() => {
              if (!active) onSelect(agent.id);
            }}
          >
            <span className={styles.icon} aria-hidden="true">
              <AgentIcon id={agent.id} size={16} />
            </span>
            <span className={styles.name}>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
