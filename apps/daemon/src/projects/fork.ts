import path from 'node:path';
import type { ChatAttachment, Project, ProjectMetadata } from '@open-design/contracts';
import { copyProjectFile, resolveProjectDir, validateProjectPath } from '../projects.js';

export class ProjectForkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly attachmentName?: string,
  ) {
    super(message);
  }
}

// Copy generation choices, never filesystem bindings, publication state,
// completed-work markers, or project-owned plugin snapshot identities.
const GENERATION_KEYS = [
  'intent', 'fidelity', 'speakerNotes', 'slideCount', 'animations',
  'includeLandingPage', 'includeOsWidgets', 'templateId', 'templateLabel',
  'platform', 'platformTargets', 'inspirationDesignSystemIds',
  'imageModel', 'imageAspect', 'imageStyle', 'videoModel', 'videoLength',
  'videoAspect', 'audioKind', 'audioModel', 'audioDuration', 'voice',
  'promptTemplate', 'skipDiscoveryBrief', 'contextPlugins',
  'contextMcpServers', 'contextConnectors', 'localCatalogScopes',
] as const satisfies readonly (keyof ProjectMetadata)[];

export function projectForkMetadata(source: Project): ProjectMetadata {
  const metadata = source.metadata;
  return {
    ...Object.fromEntries(GENERATION_KEYS.flatMap((key) =>
      metadata?.[key] === undefined ? [] : [[key, structuredClone(metadata[key])]],
    )),
    kind: metadata?.kind ?? 'other',
    nameSource: 'user',
    sourceProjectId: source.id,
    sourceProjectName: source.name,
  };
}

/** Accept legacy absolute paths only when contained by the source workspace.
 * The file API independently enforces realpath/symlink containment. */
export function forkAttachmentPath(root: string, attachmentPath: string): string {
  const paths = path.win32.isAbsolute(root) && !path.posix.isAbsolute(root) ? path.win32 : path;
  const normalized = attachmentPath.replace(/\\/g, '/');
  const relative = paths.isAbsolute(normalized) ? paths.relative(root, normalized) : normalized;
  return validateProjectPath(relative);
}

export async function copyForkAttachments(
  projectsRoot: string,
  source: Project,
  targetProjectId: string,
  attachments: readonly ChatAttachment[],
): Promise<{ attachments: ChatAttachment[]; copiedFiles: string[] }> {
  const root = resolveProjectDir(projectsRoot, source.id, source.metadata);
  const copied = new Map<string, { name: string; size: number }>();
  const result: ChatAttachment[] = [];
  for (const attachment of attachments) {
    const displayName = attachment?.name || attachment?.path || '(unknown)';
    try {
      const name = forkAttachmentPath(root, attachment.path);
      let file = copied.get(name);
      if (!file) {
        file = await copyProjectFile(projectsRoot, source.id, targetProjectId, name, source.metadata);
        copied.set(name, file);
      }
      result.push({
        path: file.name,
        name: displayName,
        kind: attachment.kind === 'image' ? 'image' : 'file',
        size: file.size,
        order: attachment.order ?? result.length,
      });
    } catch {
      throw new ProjectForkError(
        'FORK_ATTACHMENT_UNAVAILABLE',
        `Could not copy attachment "${displayName}". Restore or reattach the file in the source project, then try again.`,
        409,
        displayName,
      );
    }
  }
  return { attachments: result, copiedFiles: [...copied.keys()] };
}
