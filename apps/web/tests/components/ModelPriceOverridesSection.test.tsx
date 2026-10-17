// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ModelPriceOverridesSection,
  requestModelPricesFocus,
} from '../../src/components/spend/ModelPriceOverridesSection';
import { I18nProvider } from '../../src/i18n';

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function renderSection() {
  return render(
    <I18nProvider initial="en">
      <ModelPriceOverridesSection />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ModelPriceOverridesSection', () => {
  it('stays collapsed and reads nothing until it is opened', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ config: { modelPriceOverrides: { 'gpt-5.4': { input: 1, output: 2 } } } }),
    );
    renderSection();
    const toggle = screen.getByTestId('settings-model-prices-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(screen.getByDisplayValue('gpt-5.4')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/app-config');
  });

  it('opens itself when the spend dialog asked for it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ config: {} }));
    Element.prototype.scrollIntoView = vi.fn();
    requestModelPricesFocus();
    renderSection();
    expect(screen.getByTestId('settings-model-prices-toggle').getAttribute('aria-expanded')).toBe('true');
    await screen.findByText('No custom prices. Standard API prices are used.');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('saves edited rows as modelPriceOverrides', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        return json({ config: { modelPriceOverrides: body.modelPriceOverrides } });
      }
      return json({ config: {} });
    });
    renderSection();
    fireEvent.click(screen.getByTestId('settings-model-prices-toggle'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add model' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model ID' }), { target: { value: 'my-llama' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Input $/1M' }), { target: { value: '0.5' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Output $/1M' }), { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('settings-model-prices-save'));

    await screen.findByText('Saved');
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      modelPriceOverrides: { 'my-llama': { input: 0.5, output: 1.5 } },
    });
  });

  it('keeps the form locked when the saved prices fail to load, so a save cannot erase them', async () => {
    let configReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      configReads += 1;
      if (configReads === 1) return new Response('unavailable', { status: 503 });
      return json({ config: { modelPriceOverrides: { 'gpt-5.4': { input: 1, output: 2 } } } });
    });
    renderSection();
    fireEvent.click(screen.getByTestId('settings-model-prices-toggle'));

    await screen.findByText("Couldn't load your saved prices.");
    expect(screen.queryByText('No custom prices. Standard API prices are used.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Add model' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('settings-model-prices-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByDisplayValue('gpt-5.4')).toBeTruthy());
    expect(screen.queryByText("Couldn't load your saved prices.")).toBeNull();
  });
});
