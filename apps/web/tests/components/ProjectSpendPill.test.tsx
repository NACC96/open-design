// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSpendResponse } from '@open-design/contracts';

import { ProjectSpendPill } from '../../src/components/spend/ProjectSpendPill';
import { I18nProvider } from '../../src/i18n';

function bucket(costUsd: number, turns: number, extra: Partial<ProjectSpendResponse['total']> = {}) {
  return {
    costUsd,
    turns,
    pricedTurns: turns,
    reportedTurns: 0,
    estimatedTurns: 0,
    unpricedTurns: 0,
    tokens: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0 },
    ...extra,
  };
}

function spendResponse(overrides: Partial<ProjectSpendResponse> = {}): ProjectSpendResponse {
  return {
    projectId: 'proj-1',
    currency: 'USD',
    priceTableDate: '2026-10-16',
    generatedAt: 1,
    total: bucket(3.5, 3, { unpricedTurns: 1, pricedTurns: 2 }),
    byModel: [
      { ...bucket(3.5, 2), model: 'claude-opus-5-5', agentIds: ['claude'], priceSource: 'bundled', price: { input: 4, output: 20 } },
      { ...bucket(0, 1, { pricedTurns: 0, unpricedTurns: 1 }), model: 'my-llama', agentIds: ['opencode'], priceSource: null, price: null },
    ],
    byConversation: [
      { ...bucket(3.5, 3), conversationId: 'conv-1', title: 'Landing page', updatedAt: 1 },
    ],
    ...overrides,
  };
}

function mockSpend(body: ProjectSpendResponse) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

function renderPill(props: Partial<Parameters<typeof ProjectSpendPill>[0]> = {}) {
  const onEditPrices = vi.fn();
  const utils = render(
    <I18nProvider initial="en">
      <ProjectSpendPill projectId="proj-1" streaming={false} onEditPrices={onEditPrices} {...props} />
    </I18nProvider>,
  );
  return { ...utils, onEditPrices };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProjectSpendPill', () => {
  it('shows the project total once usage exists and opens the breakdown', async () => {
    const fetchMock = mockSpend(spendResponse());
    renderPill();
    const pill = await screen.findByTestId('project-spend-pill');
    expect(pill.textContent).toContain('$3.50');
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-1/spend', undefined);

    fireEvent.click(pill);
    const dialog = await screen.findByTestId('project-spend-dialog');
    const models = within(dialog).getByTestId('project-spend-models');
    expect(within(models).getByText('claude-opus-5-5')).toBeTruthy();
    expect(within(models).getByText('Standard API price')).toBeTruthy();
    expect(within(models).getByText('No price')).toBeTruthy();
    expect(within(dialog).getByText(/used a model with no known price/)).toBeTruthy();
    expect(within(dialog).getByText('Standard prices as of 2026-10-16')).toBeTruthy();
  });

  it('stays hidden while the project has no recorded usage', async () => {
    const fetchMock = mockSpend(spendResponse({ total: bucket(0, 0), byModel: [], byConversation: [] }));
    renderPill();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('project-spend-pill')).toBeNull();
  });

  it('stays hidden when the daemon answers with something that is not a spend report', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    renderPill();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('project-spend-pill')).toBeNull();
  });

  it('refreshes when a running turn finishes', async () => {
    const fetchMock = mockSpend(spendResponse());
    const { rerender } = renderPill({ streaming: true });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(
      <I18nProvider initial="en">
        <ProjectSpendPill projectId="proj-1" streaming={false} onEditPrices={vi.fn()} />
      </I18nProvider>,
    );
    await screen.findByTestId('project-spend-pill');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the user to Settings to edit prices', async () => {
    mockSpend(spendResponse());
    const { onEditPrices } = renderPill();
    fireEvent.click(await screen.findByTestId('project-spend-pill'));
    fireEvent.click(await screen.findByTestId('project-spend-edit-prices'));
    expect(onEditPrices).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('project-spend-dialog')).toBeNull();
  });
});
