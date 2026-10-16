import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectSpendResponse, WorkspaceCollabContext } from '@open-design/contracts';

import { useT } from '../../i18n';
import { formatSpendUsd } from '../../runtime/project-spend-format';
import { getProjectSpend } from '../../state/projects';
import { Icon } from '../Icon';
import { requestModelPricesFocus } from './ModelPriceOverridesSection';
import { ProjectSpendDialog } from './ProjectSpendDialog';
import styles from './ProjectSpend.module.css';

export interface ProjectSpendPillProps {
  projectId: string;
  workspaceContext?: WorkspaceCollabContext | null;
  /** True while the open conversation has a turn running; spend refreshes when it ends. */
  streaming: boolean;
  onEditPrices: () => void;
}

/**
 * The project's API-equivalent spend, docked in the chat column header.
 * Hidden until the project has recorded usage; refreshed when a turn ends and
 * whenever the breakdown is opened.
 */
export function ProjectSpendPill({
  projectId,
  workspaceContext = null,
  streaming,
  onEditPrices,
}: ProjectSpendPillProps) {
  const t = useT();
  const [spend, setSpend] = useState<ProjectSpendResponse | null>(null);
  const [open, setOpen] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const next = await getProjectSpend(projectId, { workspaceContext });
    // A later request (or a project switch) owns the state now.
    if (request !== requestRef.current) return;
    if (next) setSpend(next);
  }, [projectId, workspaceContext]);

  useEffect(() => {
    setSpend(null);
  }, [projectId]);

  useEffect(() => {
    if (streaming) return;
    void load();
  }, [load, streaming]);

  const openDialog = () => {
    setOpen(true);
    void load();
  };

  const visible = Boolean(spend && spend.projectId === projectId && spend.total.turns > 0);
  const amount = spend ? formatSpendUsd(spend.total.costUsd) : '';
  return (
    <>
      {visible ? (
        <button
          type="button"
          className={`${styles.pill} od-tooltip`}
          onClick={openDialog}
          aria-label={t('spend.pillAria', { amount })}
          data-tooltip={t('spend.pillTooltip')}
          data-tooltip-placement="bottom"
          data-testid="project-spend-pill"
        >
          <Icon name="bar-chart-box" size={14} />
          <span>{amount}</span>
        </button>
      ) : null}
      {open ? (
        <ProjectSpendDialog
          spend={spend}
          onClose={() => setOpen(false)}
          onEditPrices={() => {
            setOpen(false);
            requestModelPricesFocus();
            onEditPrices();
          }}
        />
      ) : null}
    </>
  );
}
