import { describe, expect, it } from 'vitest';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  canPublishPublicFile,
  publicFilePublishFailureKey,
} from '../src/collab/public-file-publish';

function context(overrides: Partial<WorkspaceCollabContext> = {}): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
    ...overrides,
  };
}

describe('canPublishPublicFile', () => {
  it('never offers Cloud publishing, including with a lingering signed-in session', () => {
    for (const workspace of [context(), context({ workspaceType: 'personal' }), null, undefined]) {
      expect(canPublishPublicFile(workspace)).toBe(false);
    }
  });
});

describe('publicFilePublishFailureKey', () => {
  it('maps the workspace-identity refusal to its own explanation', () => {
    // Sign-in, NOT "switch to a team" — the gate is no longer team-scoped, and
    // the old copy sent personal users after a workspace they do not need.
    expect(publicFilePublishFailureKey(new Error('WORKSPACE_IDENTITY_REQUIRED'))).toBe(
      'fileViewer.publishFileRequiresWorkspace',
    );
  });

  it('falls back to a generic failure for anything else', () => {
    expect(publicFilePublishFailureKey(new Error('PUBLIC_FILE_URL_UNAVAILABLE'))).toBe(
      'fileViewer.publishFileFailed',
    );
    expect(publicFilePublishFailureKey(null)).toBe('fileViewer.publishFileFailed');
  });
});
