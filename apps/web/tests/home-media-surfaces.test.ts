import { describe, expect, it } from 'vitest';

import {
  buildHomeMediaComposer,
  metadataForHomeMediaComposer,
} from '../src/components/home-hero/media-surfaces';
import { DEFAULT_VIDEO_MODEL } from '../src/media/models';

describe('Home image composer metadata', () => {
  it('persists the default Codex Subscription model into project metadata', () => {
    const composer = buildHomeMediaComposer('image', []);

    expect(composer.inputs.model).toBe('codex-gpt-image-2');
    expect(metadataForHomeMediaComposer('image', composer.inputs, [])).toEqual({
      kind: 'image',
      imageModel: 'codex-gpt-image-2',
    });
  });

  it('labels the default image model as gpt-image-2 (Codex) in the model field', () => {
    const composer = buildHomeMediaComposer('image', []);
    const modelField = composer.fields.find((field) => field.name === 'model');

    expect(JSON.stringify(modelField)).toContain('gpt-image-2 (Codex)');
    expect(JSON.stringify(modelField)).not.toContain('vela/');
  });

  it('preserves an explicitly selected OpenAI BYOK model', () => {
    const composer = buildHomeMediaComposer('image', [], { model: 'gpt-image-2' });

    expect(metadataForHomeMediaComposer('image', composer.inputs, [])).toEqual({
      kind: 'image',
      imageModel: 'gpt-image-2',
    });
  });

  it('replaces a removed Cloud image model with the Codex default', () => {
    const composer = buildHomeMediaComposer('image', [], { model: 'vela/gpt-image-2' });

    expect(composer.inputs.model).toBe('codex-gpt-image-2');
  });
});

describe('Home video composer defaults', () => {
  it('keeps the video and HyperFrames defaults unchanged', () => {
    expect(DEFAULT_VIDEO_MODEL).toBe('doubao-seedance-2-0-260128');
    expect(buildHomeMediaComposer('video', []).inputs.model).toBe('doubao-seedance-2-0-260128');
    const hyperframes = buildHomeMediaComposer('hyperframes', []);
    expect(hyperframes.inputs.model).toBe('hyperframes-html');
    expect(metadataForHomeMediaComposer('hyperframes', hyperframes.inputs, [])).toEqual({
      kind: 'video',
      intent: 'hyperframes',
      videoModel: 'hyperframes-html',
    });
  });
});
