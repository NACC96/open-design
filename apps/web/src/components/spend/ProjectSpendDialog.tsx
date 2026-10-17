import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-design/components';
import type { ProjectSpendResponse } from '@open-design/contracts';

import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import {
  formatSpendUsd,
  formatTokenCount,
  spendPriceLabel,
  totalTokens,
  type SpendPriceLabel,
} from '../../runtime/project-spend-format';
import styles from './ProjectSpend.module.css';

const PRICE_LABEL_KEYS: Record<SpendPriceLabel, keyof Dict> = {
  reported: 'spend.sourceReported',
  bundled: 'spend.sourceBundled',
  override: 'spend.sourceOverride',
  catalog: 'spend.sourceCatalog',
  none: 'spend.sourceNone',
};

export interface ProjectSpendDialogProps {
  spend: ProjectSpendResponse | null;
  onClose: () => void;
  /** Opens Settings where model prices are edited. */
  onEditPrices: () => void;
}

export function ProjectSpendDialog({ spend, onClose, onEditPrices }: ProjectSpendDialogProps) {
  const t = useT();
  const total = spend?.total ?? null;
  const hasUsage = Boolean(total && total.turns > 0);
  return (
    <Dialog
      ariaLabelledBy="project-spend-title"
      ariaDescribedBy="project-spend-description"
      className={styles.dialog}
      closeOnEscape
      data-testid="project-spend-dialog"
      onClose={onClose}
    >
      <DialogHeader>
        <DialogTitle id="project-spend-title">{t('spend.title')}</DialogTitle>
        <DialogDescription id="project-spend-description">
          {t('spend.description')}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className={styles.scroll}>
        {!spend ? (
          <p className={styles.empty}>{t('spend.loadFailed')}</p>
        ) : !hasUsage || !total ? (
          <p className={styles.empty}>{t('spend.empty')}</p>
        ) : (
          <>
            <div className={styles.summary} data-testid="project-spend-summary">
              <span className={styles.total}>{formatSpendUsd(total.costUsd)}</span>
              <span className={styles.summaryMeta}>
                <span>{t('spend.turnsSummary', { count: total.turns })}</span>
                <span>
                  {t('spend.tokensSummary', {
                    input: formatTokenCount(total.tokens.input),
                    cacheRead: formatTokenCount(total.tokens.cacheRead),
                    cacheWrite: formatTokenCount(total.tokens.cacheWrite),
                    output: formatTokenCount(total.tokens.output),
                  })}
                </span>
              </span>
            </div>
            {total.estimatedTurns > 0 || total.unpricedTurns > 0 ? (
              <ul className={styles.notes}>
                {total.estimatedTurns > 0 ? (
                  <li>{t('spend.estimatedNote', { count: total.estimatedTurns })}</li>
                ) : null}
                {total.unpricedTurns > 0 ? (
                  <li>{t('spend.unpricedNote', { count: total.unpricedTurns })}</li>
                ) : null}
              </ul>
            ) : null}
            <section>
              <h3 className={styles.sectionTitle}>{t('spend.byModel')}</h3>
              <table className={styles.table} data-testid="project-spend-models">
                <thead>
                  <tr>
                    <th>{t('spend.colModel')}</th>
                    <th className={styles.numeric}>{t('spend.colTurns')}</th>
                    <th className={styles.numeric}>{t('spend.colTokens')}</th>
                    <th className={styles.numeric}>{t('spend.colCost')}</th>
                    <th>{t('spend.colPrice')}</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.byModel.map((row) => {
                    const label = spendPriceLabel(row);
                    return (
                      <tr key={row.model ?? ''}>
                        <td className={styles.primaryCell} title={row.model ?? undefined}>
                          {row.model ?? t('spend.unknownModel')}
                          {row.agentIds.length > 0 ? (
                            <span className={styles.secondary}>{row.agentIds.join(', ')}</span>
                          ) : null}
                        </td>
                        <td className={styles.numeric}>{row.turns}</td>
                        <td className={styles.numeric}>{formatTokenCount(totalTokens(row))}</td>
                        <td className={styles.numeric}>
                          {row.pricedTurns > 0 ? formatSpendUsd(row.costUsd) : '—'}
                        </td>
                        <td
                          className={[styles.source, label === 'none' ? styles.sourceMissing : '']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {t(PRICE_LABEL_KEYS[label])}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            <section>
              <h3 className={styles.sectionTitle}>{t('spend.byConversation')}</h3>
              <table className={styles.table} data-testid="project-spend-conversations">
                <thead>
                  <tr>
                    <th>{t('spend.colConversation')}</th>
                    <th className={styles.numeric}>{t('spend.colTurns')}</th>
                    <th className={styles.numeric}>{t('spend.colCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.byConversation.map((row) => (
                    <tr key={row.conversationId}>
                      <td className={styles.primaryCell} title={row.title ?? undefined}>
                        {row.title || t('spend.untitledConversation')}
                      </td>
                      <td className={styles.numeric}>{row.turns}</td>
                      <td className={styles.numeric}>
                        {row.pricedTurns > 0 ? formatSpendUsd(row.costUsd) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </DialogBody>
      <DialogFooter className={styles.footer}>
        <span className={styles.source}>
          {spend ? t('spend.priceDate', { date: spend.priceTableDate }) : null}
        </span>
        <span>
          <Button variant="ghost" onClick={onEditPrices} data-testid="project-spend-edit-prices">
            {t('spend.editPrices')}
          </Button>{' '}
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      </DialogFooter>
    </Dialog>
  );
}
