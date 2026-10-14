import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PACKAGED_NAMESPACE_BASE_ROOT_ENV,
  resolvePackagedAmrProfile,
  resolvePackagedNamespaceBaseRoot,
  resolvePackagedUpdaterFeedEnv,
  resolvePackagedUpdaterPolicyEnv,
} from '../src/config.js';

describe('packaged updater switch', () => {
  it('keeps a fork off the official updater after a normal app launch', () => {
    expect(resolvePackagedUpdaterPolicyEnv({ updateEnabled: false }, {})).toEqual({ OD_UPDATE_ENABLED: '0' });
  });

  it('maps a baked opt-in to the runtime value 1', () => {
    expect(resolvePackagedUpdaterPolicyEnv({ updateEnabled: true }, {})).toEqual({ OD_UPDATE_ENABLED: '1' });
  });

  it('leaves packages without a baked switch on the runtime default', () => {
    expect(resolvePackagedUpdaterPolicyEnv({}, {})).toEqual({});
  });

  it('lets a non-empty launch value override the baked switch', () => {
    expect(resolvePackagedUpdaterPolicyEnv({ updateEnabled: false }, { OD_UPDATE_ENABLED: '1' })).toEqual({});
    expect(resolvePackagedUpdaterPolicyEnv({ updateEnabled: false }, { OD_UPDATE_ENABLED: '' }))
      .toEqual({ OD_UPDATE_ENABLED: '0' });
  });

  it('keeps the inherited opt-out when a delegated payload resolves its own config', () => {
    const launchEnv: NodeJS.ProcessEnv = {};
    Object.assign(launchEnv, resolvePackagedUpdaterPolicyEnv({ updateEnabled: false }, launchEnv));
    // The payload process starts from the outer's environment and reads its
    // own bundle config, which an official payload leaves without the switch.
    const payloadEnv: NodeJS.ProcessEnv = { ...launchEnv };
    expect(resolvePackagedUpdaterPolicyEnv({}, payloadEnv)).toEqual({});
    expect(resolvePackagedUpdaterPolicyEnv({ updateEnabled: true }, payloadEnv)).toEqual({});
    expect(payloadEnv.OD_UPDATE_ENABLED).toBe('0');
  });
});

describe('packaged updater feed', () => {
  it('applies the baked metadata URL when the launch environment has none', () => {
    expect(resolvePackagedUpdaterFeedEnv({ updateMetadataUrl: 'https://fork.example/metadata.json' }, {}))
      .toEqual({ OD_UPDATE_METADATA_URL: 'https://fork.example/metadata.json' });
    expect(resolvePackagedUpdaterFeedEnv(
      { updateMetadataUrl: 'https://fork.example/metadata.json' },
      { OD_UPDATE_METADATA_URL: '' },
    )).toEqual({ OD_UPDATE_METADATA_URL: 'https://fork.example/metadata.json' });
  });

  it('leaves the default feed alone when nothing was baked', () => {
    expect(resolvePackagedUpdaterFeedEnv({ updateMetadataUrl: null }, {})).toEqual({});
  });

  it('lets a non-empty launch metadata URL override the baked one', () => {
    expect(resolvePackagedUpdaterFeedEnv(
      { updateMetadataUrl: 'https://fork.example/metadata.json' },
      { OD_UPDATE_METADATA_URL: 'https://fixture.example/metadata.json' },
    )).toEqual({});
  });
});

describe('resolvePackagedNamespaceBaseRoot', () => {
  it('lets a historical handoff preserve the already-resolved namespace base root', () => {
    const inheritedRoot = join('C:', 'tools-pack', 'runtime', 'namespaces');
    const bakedRoot = join('C:', 'Users', 'Nexu', 'AppData', 'Roaming', 'Open Design', 'namespaces');

    expect(resolvePackagedNamespaceBaseRoot(bakedRoot, join('C:', 'fallback'), {
      [PACKAGED_NAMESPACE_BASE_ROOT_ENV]: inheritedRoot,
    })).toBe(resolve(inheritedRoot));
  });

  it('falls back to the payload config and then Electron userData', () => {
    const bakedRoot = join('C:', 'packaged', 'namespaces');
    const userDataRoot = join('C:', 'user-data');

    expect(resolvePackagedNamespaceBaseRoot(bakedRoot, userDataRoot, {})).toBe(resolve(bakedRoot));
    expect(resolvePackagedNamespaceBaseRoot(undefined, userDataRoot, {})).toBe(
      join(userDataRoot, 'namespaces'),
    );
  });
});

describe('resolvePackagedAmrProfile', () => {
  it('accepts a whitespace-trimmed feature-test profile', () => {
    expect(resolvePackagedAmrProfile(' feature-test ')).toBe('feature-test');
  });

  it('maps empty values to null', () => {
    expect(resolvePackagedAmrProfile(undefined)).toBeNull();
    expect(resolvePackagedAmrProfile('   ')).toBeNull();
  });

  it('rejects unsupported profiles', () => {
    expect(() => resolvePackagedAmrProfile('staging')).toThrow(
      'unsupported packaged AMR profile; expected prod, test, feature-test, or local: staging',
    );
  });
});
