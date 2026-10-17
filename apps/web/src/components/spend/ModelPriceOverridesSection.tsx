import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@open-design/components';
import { MODEL_PRICE_TABLE_DATE, type AppConfigResponse } from '@open-design/contracts';

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import {
  BUNDLED_PRICE_MODEL_IDS,
  emptyPriceOverrideRow,
  overridesFromRows,
  prefillFromBundled,
  rowsFromOverrides,
  type PriceOverrideRow,
} from '../../runtime/model-price-overrides';
import { fetchDaemonConfig } from '../../state/config';
import styles from './ModelPriceOverridesSection.module.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

let focusRequested = false;

/**
 * Ask the next Model prices section that mounts to open and scroll itself
 * into view. The project spend dialog's "Edit prices" link sets this before
 * opening Settings, which otherwise lands at the top of a long agent list.
 */
export function requestModelPricesFocus(): void {
  focusRequested = true;
}

/**
 * Settings → Models & providers → Model prices: per-1M-token prices that
 * outrank the bundled table in project spend, for turns whose agent did not
 * report its own cost. Stored daemon-side as `modelPriceOverrides` in app
 * config, which is also what `od config set modelPriceOverrides --value-json …`
 * edits.
 *
 * A collapsed disclosure at the foot of a long page: the stored prices are
 * read the first time it opens, not on every visit to the page.
 */
export function ModelPriceOverridesSection() {
  const t = useT();
  const [expanded, setExpanded] = useState(() => focusRequested);
  const [rows, setRows] = useState<PriceOverrideRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [invalidRowIds, setInvalidRowIds] = useState<string[]>([]);
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded || loaded) return;
    let cancelled = false;
    void fetchDaemonConfig().then((config) => {
      if (cancelled) return;
      // A failed read is not "no overrides": editing from it and saving would
      // replace the stored map with only the new rows.
      if (!config) {
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      setRows(rowsFromOverrides(config.modelPriceOverrides));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, loaded, loadAttempt]);

  useEffect(() => {
    // The collapsed body stays mounted for its exit transition; keep it out
    // of the tab order and the accessibility tree while it is closed.
    if (bodyRef.current) bodyRef.current.inert = !expanded;
  }, [expanded]);

  useEffect(() => {
    if (!loaded || !focusRequested) return;
    focusRequested = false;
    sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [loaded]);

  const edit = (next: PriceOverrideRow[]) => {
    setRows(next);
    setDirty(true);
    setSaveState('idle');
  };

  const updateRow = (id: string, patch: Partial<PriceOverrideRow>) => {
    edit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const save = async () => {
    const result = overridesFromRows(rows);
    if (!result.ok) {
      setInvalidRowIds(result.invalidRowIds);
      setSaveState('invalid');
      return;
    }
    setInvalidRowIds([]);
    setSaveState('saving');
    try {
      const resp = await fetch('/api/app-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelPriceOverrides: result.overrides }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as AppConfigResponse;
      setRows(rowsFromOverrides(body.config.modelPriceOverrides));
      setDirty(false);
      setSaveState('saved');
    } catch {
      setSaveState('failed');
    }
  };

  const fieldLabel: Record<(typeof PRICE_FIELDS)[number], string> = {
    input: t('settings.modelPricesInput'),
    output: t('settings.modelPricesOutput'),
    cacheRead: t('settings.modelPricesCacheRead'),
    cacheWrite: t('settings.modelPricesCacheWrite'),
  };

  return (
    <section ref={sectionRef} className="settings-section" data-testid="settings-model-prices">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls="settings-model-prices-body"
        onClick={() => setExpanded((open) => !open)}
        data-testid="settings-model-prices-toggle"
      >
        <span className={styles.toggleText}>
          <span className={styles.title}>{t('settings.modelPrices')}</span>
          <span className="hint">{t('settings.modelPricesHint', { date: MODEL_PRICE_TABLE_DATE })}</span>
        </span>
        <Icon name="chevron-down" size={16} className={expanded ? styles.chevronOpen : styles.chevron} />
      </button>
      <div
        id="settings-model-prices-body"
        ref={bodyRef}
        className={`accordion-collapsible${expanded ? ' open' : ''}`}
      >
        <div className="accordion-collapsible-inner">
          <div className={styles.body}>
            <datalist id="model-price-bundled-ids">
              {BUNDLED_PRICE_MODEL_IDS.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {loadFailed ? (
              <p className={styles.empty} role="alert">
                {t('settings.modelPricesLoadFailed')}{' '}
                <Button variant="ghost" size="sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                  {t('settings.modelPricesRetry')}
                </Button>
              </p>
            ) : null}
            {loaded && rows.length === 0 ? (
              <p className={styles.empty}>{t('settings.modelPricesEmpty')}</p>
            ) : null}
            {rows.length > 0 ? (
              <div className={styles.table} role="table" aria-label={t('settings.modelPrices')}>
                <div className={styles.headRow} role="row">
                  <span role="columnheader">{t('settings.modelPricesModel')}</span>
                  {PRICE_FIELDS.map((field) => (
                    <span key={field} role="columnheader">{fieldLabel[field]}</span>
                  ))}
                  <span aria-hidden />
                </div>
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className={styles.row}
                    role="row"
                    data-invalid={invalidRowIds.includes(row.id) || undefined}
                  >
                    <Input
                      aria-label={t('settings.modelPricesModel')}
                      list="model-price-bundled-ids"
                      value={row.model}
                      placeholder="claude-opus-5-5"
                      onChange={(event) => updateRow(row.id, { model: event.target.value })}
                      onBlur={() => {
                        const filled = prefillFromBundled(row);
                        if (filled !== row) updateRow(row.id, filled);
                      }}
                    />
                    {PRICE_FIELDS.map((field) => (
                      <Input
                        key={field}
                        aria-label={fieldLabel[field]}
                        inputMode="decimal"
                        value={row[field]}
                        placeholder={field === 'cacheRead' || field === 'cacheWrite' ? '—' : '0.00'}
                        onChange={(event) => updateRow(row.id, { [field]: event.target.value })}
                      />
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => edit(rows.filter((candidate) => candidate.id !== row.id))}
                    >
                      {t('settings.modelPricesRemove')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => edit([...rows, emptyPriceOverrideRow()])} disabled={!loaded}>
                {t('settings.modelPricesAdd')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={!loaded || !dirty || saveState === 'saving'}
                data-testid="settings-model-prices-save"
              >
                {t('settings.modelPricesSave')}
              </Button>
              <span className={styles.status} role="status">
                {saveState === 'saved' ? t('settings.modelPricesSaved') : null}
                {saveState === 'failed' ? t('settings.modelPricesSaveFailed') : null}
                {saveState === 'invalid' ? t('settings.modelPricesInvalid') : null}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
