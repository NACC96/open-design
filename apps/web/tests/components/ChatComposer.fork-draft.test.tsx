// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '@open-design/contracts';
import { ChatComposer } from '../../src/components/ChatComposer';
import { UserMessageImpl } from '../../src/components/ChatPane';
import { loadComposerDraftExtras } from '../../src/runtime/chat/composer-draft';
import { composerText, flushMounts, typeAndSettle } from '../helpers/lexical-composer';

const KEY = 'od:chat-composer:draft:fork:conversation';
const attachments: ChatAttachment[] = [
  { name: 'Brief.xlsx', path: 'inputs/Brief.xlsx', kind: 'file', order: 0 },
  { name: 'Logo.png', path: 'logo.png', kind: 'image', order: 1 },
];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function composer(overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
  return render(<ChatComposer
    projectId="fork" projectFiles={[]} streaming={false}
    initialDraft="Make a price list" initialAttachments={attachments} draftStorageKey={KEY}
    onEnsureProject={async () => 'fork'} onSend={vi.fn()} onStop={vi.fn()}
    {...overrides}
  />);
}

describe('fork draft handoff', () => {
  it('opens editable with all attachments and acknowledges only after text and attachments are stored', async () => {
    const onSend = vi.fn();
    const acknowledge = vi.fn(() => {
      expect(window.localStorage.getItem(KEY)).toBe('Make a price list');
      expect(loadComposerDraftExtras(KEY).attachments).toEqual(attachments);
    });
    composer({ onSend, onInitialDraftPersisted: acknowledge });
    await flushMounts();
    expect(composerText()).toBe('Make a price list');
    expect(screen.getByTestId('staged-attachments').children).toHaveLength(2);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    await typeAndSettle('Make a one-page version');
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(onSend).toHaveBeenCalledWith('Make a one-page version', attachments, [], undefined);
  });

  it('restores edited text and removed attachments instead of replaying a stale server seed', async () => {
    const first = composer();
    await flushMounts();
    await typeAndSettle('Changed direction');
    fireEvent.click(within(screen.getByTestId('staged-attachments')).getByRole('button', { name: /remove.*Brief/i }));
    first.unmount();
    composer();
    await flushMounts();
    expect(composerText()).toBe('Changed direction');
    expect(loadComposerDraftExtras(KEY).attachments).toEqual([attachments[1]]);
    expect(screen.getByTestId('staged-attachments').children).toHaveLength(1);
  });

  it('keeps an intentionally cleared draft empty after remount', async () => {
    const first = composer({ initialAttachments: [] });
    await flushMounts();
    await typeAndSettle('');
    first.unmount();
    composer({ initialAttachments: [] });
    await flushMounts();
    expect(composerText().trim()).toBe('');
  });

  it('does not consume the server seed when browser storage fails', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    const acknowledge = vi.fn();
    composer({ onInitialDraftPersisted: acknowledge });
    await flushMounts();
    expect(composerText()).toBe('Make a price list');
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('preserves more than the ordinary draft attachment limit across a reload', async () => {
    const many = Array.from({ length: 65 }, (_, i): ChatAttachment => ({ name: `Asset ${i}.png`, path: `assets/${i}.png`, kind: 'image', order: i }));
    const first = composer({ initialAttachments: many });
    await flushMounts();
    expect(loadComposerDraftExtras(KEY).attachments).toHaveLength(65);
    first.unmount();
    const onSend = vi.fn();
    composer({ initialAttachments: undefined, initialDraft: undefined, onSend });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(onSend.mock.calls[0]?.[1]).toEqual(many);
  });
});

describe('user message fork action', () => {
  it('is available for an attachment-only message and disables repeat clicks while busy', async () => {
    const onForkProject = vi.fn();
    const message = { id: 'saved', role: 'user' as const, content: '', attachments };
    const props = { message, projectId: 'source', t: (key: string) => key, onForkProject };
    const view = render(<UserMessageImpl {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.forkProject' }));
    expect(onForkProject).toHaveBeenCalledWith(message);
    view.rerender(<UserMessageImpl {...props} forkProjectBusy forkProjectDisabled />);
    const action = screen.getByRole('button', { name: 'chat.forkProjectBusy' });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(action);
    expect(onForkProject).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(action.getAttribute('aria-busy')).toBe('true'));
  });
});
