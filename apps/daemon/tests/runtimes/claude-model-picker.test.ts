import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  isKnownReasoningEffort,
  mergeFallbackModelMetadata,
  reasoningOptionsForModel,
  resolveRequestedRunModel,
  resolveRunReasoningEffort,
} from '../../src/runtimes/models.js';
import { confirmReasoningCapability } from '../../src/runtimes/reasoning-capability.js';

afterEach(() => agentCapabilities.delete('claude'));

// The chat run's own validation path (server.ts `startChatRun`): resolve the
// model the run will use, then keep the effort only if that model — or the
// agent, when no model is known — lists it.
function validatedRunOptions(request: { model: string | null; reasoning: string }, savedModel: string | null = null) {
  const model = resolveRequestedRunModel(claudeAgentDef, request.model, savedModel, {});
  return { model, reasoning: resolveRunReasoningEffort(claudeAgentDef, model, request.reasoning) };
}

function effortArg(args: string[]): string | null {
  const index = args.indexOf('--effort');
  return index === -1 ? null : args[index + 1] ?? null;
}

describe('Claude model and effort selection', () => {
  it('offers Haiku 5.5 with all supported effort levels', () => {
    const model = claudeAgentDef.fallbackModels.find((entry) => entry.id === 'claude-haiku-5-5');
    expect(model?.label).toBe('Haiku 5.5');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isKnownReasoningEffort(claudeAgentDef, 'claude-haiku-5-5', effort)).toBe(true);
    }
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('forwards %s to Claude with the explicit model', (reasoning) => {
    agentCapabilities.set('claude', { effort: true });
    const args = claudeAgentDef.buildArgs('', [], [], { model: 'claude-haiku-5-5', reasoning });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-haiku-5-5']);
    expect(effortArg(args)).toBe(reasoning);
  });

  it('preserves Claude settings when effort is inherited', () => {
    agentCapabilities.set('claude', { effort: true });
    for (const reasoning of [undefined, 'default']) {
      expect(claudeAgentDef.buildArgs('', [], [], {
        model: 'haiku', ...(reasoning === undefined ? {} : { reasoning }),
      })).not.toContain('--effort');
    }
    expect(claudeAgentDef.buildArgs('', [], [], { model: 'default', reasoning: 'default' })).not.toContain('--model');
  });

  it('keeps unsupported effort levels out of older model choices', () => {
    expect(isKnownReasoningEffort(claudeAgentDef, 'claude-haiku-4-5', 'high')).toBe(false);
    expect(isKnownReasoningEffort(claudeAgentDef, 'claude-sonnet-4-6', 'high')).toBe(true);
    expect(isKnownReasoningEffort(claudeAgentDef, 'claude-sonnet-4-6', 'xhigh')).toBe(false);
    expect(isKnownReasoningEffort(claudeAgentDef, 'claude-haiku-5-5', '--bad-flag')).toBe(false);
  });

  it('preserves effort metadata when a proxy route supplies the current model', () => {
    const [model] = mergeFallbackModelMetadata(claudeAgentDef, [{ id: 'claude-haiku-5-5', label: 'Proxy Haiku' }]);
    expect(model?.reasoningOptions?.some((option) => option.id === 'max')).toBe(true);
  });
});

describe('Claude effort with no selected model (regression)', () => {
  it('forwards --effort for { model: null, reasoning: "max" } through the run validation path', () => {
    agentCapabilities.set('claude', { effort: true });
    const options = validatedRunOptions({ model: null, reasoning: 'max' });
    // `null` keeps Claude Code's own configured model …
    expect(options).toEqual({ model: null, reasoning: 'max' });
    const args = claudeAgentDef.buildArgs('', [], [], options);
    // … and the effort still reaches it.
    expect(args).not.toContain('--model');
    expect(effortArg(args)).toBe('max');
  });

  it('validates the effort against the saved model when the request carries none', () => {
    expect(validatedRunOptions({ model: null, reasoning: 'max' }, 'claude-haiku-4-5')).toEqual({
      model: 'claude-haiku-4-5',
      reasoning: null,
    });
  });

  it('still drops effort for a legacy 4.5 model', () => {
    agentCapabilities.set('claude', { effort: true });
    const options = validatedRunOptions({ model: 'claude-haiku-4-5', reasoning: 'max' });
    expect(options.reasoning).toBeNull();
    expect(claudeAgentDef.buildArgs('', [], [], options)).not.toContain('--effort');
    expect(reasoningOptionsForModel(claudeAgentDef, 'claude-haiku-4-5')).toEqual([]);
  });

  it('accepts effort for a custom model id the catalog does not know', () => {
    expect(validatedRunOptions({ model: 'claude-custom-proxy', reasoning: 'high' }).reasoning).toBe('high');
  });
});

describe('Claude --effort capability gate', () => {
  it('omits --effort, without aborting, when the probe has no answer', () => {
    agentCapabilities.set('claude', {});
    const args = claudeAgentDef.buildArgs('', [], [], { model: 'haiku', reasoning: 'high' });
    expect(args).not.toContain('--effort');
  });

  it('omits --effort, without aborting, when the CLI does not advertise it', () => {
    agentCapabilities.set('claude', { effort: false });
    const args = claudeAgentDef.buildArgs('', [], [], { model: 'haiku', reasoning: 'high' });
    expect(args).not.toContain('--effort');
  });

  it('lets a confirmed effort through with no diagnostic', async () => {
    const probe = vi.fn(async () => true);
    await expect(confirmReasoningCapability(claudeAgentDef, 'max', {}, probe)).resolves.toBeNull();
    expect(probe).toHaveBeenCalledWith('claude', 'effort', {});
  });

  it('reports an omission when support is still unknown after the re-probe', async () => {
    const omission = await confirmReasoningCapability(claudeAgentDef, 'max', {}, async () => undefined);
    expect(omission).toMatchObject({
      type: 'reasoning_effort_omitted',
      agentId: 'claude',
      requested: 'max',
      flag: '--effort',
      reason: 'unknown',
    });
    expect(omission?.message).toContain('could not confirm');
  });

  it('reports an omission when the CLI explicitly lacks the flag', async () => {
    const omission = await confirmReasoningCapability(claudeAgentDef, 'max', {}, async () => false);
    expect(omission).toMatchObject({ reason: 'unsupported', flag: '--effort' });
    expect(omission?.message).toContain('Update Claude Code');
  });

  it('does not probe when there is no effort to forward', async () => {
    const probe = vi.fn(async () => undefined);
    for (const reasoning of [null, undefined, '', 'default']) {
      await expect(confirmReasoningCapability(claudeAgentDef, reasoning, {}, probe)).resolves.toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
  });
});
