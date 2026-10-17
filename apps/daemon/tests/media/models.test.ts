import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  VIDEO_MODELS,
  canonicalMediaModelId,
  findMediaModel,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('uses the no-key Codex Subscription route as the only default image model', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'codex-gpt-image-2',
    ]);
    expect(findMediaModel('codex-gpt-image-2')).toMatchObject({
      label: 'gpt-image-2 (Codex)',
      provider: 'codex',
    });
    expect(MEDIA_PROVIDERS.find((provider) => provider.id === 'codex')).toMatchObject({
      label: 'Codex Subscription',
      integrated: true,
      credentialsRequired: false,
    });
    expect(MEDIA_PROVIDERS.find((provider) => provider.id === 'codex')?.defaultBaseUrl).toBeUndefined();
  });

  it('keeps the explicit OpenAI API-key model on its own route', () => {
    expect(findMediaModel('gpt-image-2')?.provider).toBe('openai');
  });

  it('lists no OpenDesign Cloud media models or provider', () => {
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'vela')).toBe(false);
    expect([...IMAGE_MODELS, ...VIDEO_MODELS].filter((model) => model.provider === 'vela')).toEqual([]);
    expect([...IMAGE_MODELS, ...VIDEO_MODELS].filter((model) => model.id.startsWith('vela/'))).toEqual([]);
  });

  it('migrates projects saved with a removed Cloud image model to Codex', () => {
    for (const id of [
      'vela/gpt-image-2',
      'vela/nano-banana-2',
      'vela/nano-banana-2-lite',
      'vela/seedream-5.0',
      'vela/seedream-5.0-pro',
    ]) {
      expect(canonicalMediaModelId(id)).toBe('codex-gpt-image-2');
      expect(findMediaModel(id)?.provider).toBe('codex');
    }
  });

  it('keeps the removed Cloud Seedance video model on the same model via Volcengine', () => {
    expect(canonicalMediaModelId('vela/doubao-seedance-2-0-260128')).toBe('doubao-seedance-2-0-260128');
    expect(findMediaModel('vela/doubao-seedance-2-0-260128')?.provider).toBe('volcengine');
  });

  it('no longer aliases the Codex image model away', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('codex-gpt-image-2');
  });

  it('resolves the Nano Banana shorthands to the Nano Banana provider model', () => {
    for (const id of ['nano-banana', 'nano-banana-2', 'nano-banana-2-lite']) {
      expect(canonicalMediaModelId(id)).toBe('gemini-3.1-flash-image-preview');
      expect(findMediaModel(id)?.provider).toBe('nanobanana');
    }
  });

  it('keeps the video defaults unchanged', () => {
    expect(VIDEO_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'doubao-seedance-2-0-260128',
      'openrouter/bytedance/seedance-2.0:1080p',
    ]);
    expect(VIDEO_MODELS.some((model) => model.id === 'hyperframes-html')).toBe(true);
  });
});
