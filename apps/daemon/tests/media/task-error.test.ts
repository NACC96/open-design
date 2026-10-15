import { describe, expect, it } from 'vitest';
import { mediaTaskErrorFromFailure } from '../../src/media/task-error.js';

describe('media task authentication recovery after model migration', () => {
  it.each([401, 403])('uses Volcengine settings for migrated Seedance status %s', (status) => {
    const error = Object.assign(new Error(`volcengine video ${status}: rejected Ark key`), { status });
    expect(mediaTaskErrorFromFailure(error, {
      model: 'vela/doubao-seedance-2-0-260128',
    }).nextStep).toBe('open-settings');
    expect(mediaTaskErrorFromFailure(error, {
      model: 'doubao-seedance-2-0-260128',
    }).nextStep).toBe('open-settings');
  });

  it('preserves account recovery for an unmigrated Cloud model', () => {
    expect(mediaTaskErrorFromFailure(Object.assign(new Error('vela image 401: unauthorized'), { status: 401 }), {
      model: 'vela/other-cloud-model',
    }).nextStep).toBe('sign-in');
  });

  it('preserves the explicit Codex subscription login error', () => {
    expect(mediaTaskErrorFromFailure(Object.assign(new Error('Codex login required'), { code: 'CODEX_AUTH_REQUIRED' }), {
      model: 'vela/gpt-image-2',
    }).nextStep).toBe('sign-in');
  });
});
