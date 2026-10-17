/**
 * Per-project execution stamp: the local agent CLI + model a project runs on.
 *
 * A project carries `execution` (`ProjectExecutionChoice`) so each project can
 * run on its own CLI instead of every run reading the global app-config
 * `agentId` + `agentModels[agentId]`. The stamp lives in its own
 * `projects.execution_json` column, never in `metadata`: `updateProject`
 * replaces metadata wholesale and the web sends whole-metadata patches from
 * stale snapshots, which would silently revert an agent switch stored there.
 *
 * The daemon never invents a stamp. A project is stamped only by a caller
 * that names an agent explicitly:
 *   - `POST /api/projects` with an `execution` object (the Home picker and
 *     `od project create --agent` send one). Omitted or `null` → unstamped.
 *   - `POST /api/projects/:id/fork` and `/duplicate` copy the source project's
 *     stamp; an unstamped source yields an unstamped copy.
 *   - `PATCH /api/projects/:id` replaces (object) or clears (`null`) it.
 *
 * Every other creation path stays unstamped: design-system copy, folder and
 * Claude Design imports, brand pages, library edit-as-page, plugin
 * duplicate-project, the project-locations scan, team mirror materialization,
 * and routine / orbit / other internal inserts. Defaulting a stamp from
 * app-config at creation was rejected on purpose: a shared daemon's app-config
 * can belong to a different caller than the one creating the project (e2e
 * workers, external agents), and pinning the project to that agent would make
 * the outcome depend on whoever wrote app-config last.
 *
 * An unstamped project follows the app-config agent and its saved model at run
 * time, exactly as every project did before stamps existed.
 *
 * Availability is never checked here: an uninstalled CLI is a run-time
 * condition (`pickRunAgentId` falls back and says so), not a reason to refuse
 * or rewrite the stored choice.
 */
import type { ProjectExecutionChoice } from '@open-design/contracts';
import { RETIRED_AGENT_IDS } from '../runtimes/local-ai-policy.js';
import { sanitizeCustomModel as defaultSanitizeCustomModel } from '../runtimes/models.js';

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PREF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXECUTION_KEYS: ReadonlySet<string> = new Set([
  'agentId',
  'model',
  'reasoning',
  'serviceTier',
]);

type AgentDefLookup = (agentId: string) => unknown;
type SanitizeCustomModel = (id: string | null | undefined) => string | null;

export interface ProjectExecutionParseDeps {
  getAgentDef: AgentDefLookup;
  /** Defaults to the runtime's own `sanitizeCustomModel`. */
  sanitizeCustomModel?: SanitizeCustomModel;
}

export type ProjectExecutionParseResult =
  | { ok: true; value: ProjectExecutionChoice | null }
  | { ok: false; message: string };

/** Anything that may carry a stamp: a `Project`, a run's `ProjectRecord`. */
export interface ProjectExecutionHolder {
  execution?: ProjectExecutionChoice | null;
}

/** The slice of app-config this module reads. */
export interface ProjectExecutionAppConfig {
  agentModels?: Record<string, { model?: string; reasoning?: string; serviceTier?: string } | undefined>;
}

export type RunAgentSource = 'project' | 'app-config' | 'first-available';

export interface RunAgentPick {
  agentId: string | null;
  source: RunAgentSource;
  /** Set when the project had a stamp that this pick did not use. */
  projectAgentId?: string;
}

export interface RunExecutionDefaults {
  source: 'project' | 'app-config';
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeModel(value: string, sanitizeCustomModel: SanitizeCustomModel): string | null {
  if (value === 'default') return 'default';
  return sanitizeCustomModel(value);
}

function normalizePrefId(value: string): string | null {
  return PREF_ID_PATTERN.test(value) ? value : null;
}

/**
 * Validate a client-supplied `execution` value (create or PATCH body).
 *
 * `null` clears. An object must name a shipped, non-retired agent and may
 * carry a model (`'default'` or a safe custom id), reasoning level, and
 * service tier. `serviceTier: 'default'` is the same as omitting it. The
 * returned choice keeps only the keys that are present.
 */
export function parseProjectExecutionChoice(
  raw: unknown,
  deps: ProjectExecutionParseDeps,
): ProjectExecutionParseResult {
  if (raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) {
    return { ok: false, message: 'execution must be an object or null' };
  }
  const unknownKey = Object.keys(raw).find((key) => !EXECUTION_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { ok: false, message: `execution has an unknown key: ${unknownKey}` };
  }
  const { agentId, model, reasoning, serviceTier } = raw;
  if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) {
    return { ok: false, message: 'execution.agentId must be an agent id' };
  }
  if (RETIRED_AGENT_IDS.has(agentId)) {
    return { ok: false, message: `execution.agentId ${agentId} is no longer supported` };
  }
  if (deps.getAgentDef(agentId) == null) {
    return { ok: false, message: `execution.agentId ${agentId} is not a known agent` };
  }
  const value: ProjectExecutionChoice = { agentId };
  if (model !== undefined && model !== null) {
    const normalized = typeof model === 'string'
      ? normalizeModel(model, deps.sanitizeCustomModel ?? defaultSanitizeCustomModel)
      : null;
    if (!normalized) {
      return { ok: false, message: 'execution.model must be "default" or a model id' };
    }
    value.model = normalized;
  }
  if (reasoning !== undefined && reasoning !== null) {
    const normalized = typeof reasoning === 'string' ? normalizePrefId(reasoning) : null;
    if (!normalized) {
      return { ok: false, message: 'execution.reasoning must be a reasoning level id' };
    }
    value.reasoning = normalized;
  }
  if (serviceTier !== undefined && serviceTier !== null) {
    const normalized = typeof serviceTier === 'string' ? normalizePrefId(serviceTier) : null;
    if (!normalized) {
      return { ok: false, message: 'execution.serviceTier must be a service tier id' };
    }
    if (normalized !== 'default') value.serviceTier = normalized;
  }
  return { ok: true, value };
}

/**
 * Which agent a run uses when its request names none: the project's stamped
 * agent when it is installed, else the app-config agent when it is installed,
 * else the first installed agent. `projectAgentId` reports a stamp that could
 * not be honoured so the caller can say why the run fell back.
 */
export function pickRunAgentId(input: {
  stampedAgentId?: string | null;
  configuredAgentId?: string | null;
  agents: ReadonlyArray<{ id: string; available?: boolean }>;
}): RunAgentPick {
  const available = input.agents.filter(
    (agent) => agent.available === true && !RETIRED_AGENT_IDS.has(agent.id),
  );
  const isAvailable = (agentId: string | null | undefined): agentId is string =>
    typeof agentId === 'string'
    && agentId.length > 0
    && available.some((agent) => agent.id === agentId);
  const stamped = typeof input.stampedAgentId === 'string' && input.stampedAgentId
    ? input.stampedAgentId
    : null;
  if (stamped && isAvailable(stamped)) {
    return { agentId: stamped, source: 'project' };
  }
  const unusedStamp = stamped ? { projectAgentId: stamped } : {};
  if (isAvailable(input.configuredAgentId)) {
    return { agentId: input.configuredAgentId, source: 'app-config', ...unusedStamp };
  }
  return {
    agentId: available[0]?.id ?? null,
    source: 'first-available',
    ...unusedStamp,
  };
}

/** The project's stamp when it governs runs of `agentId`, else `null`. */
export function projectExecutionForAgent(
  agentId: string | null | undefined,
  project: ProjectExecutionHolder | null | undefined,
): ProjectExecutionChoice | null {
  const execution = project?.execution;
  return execution && typeof agentId === 'string' && execution.agentId === agentId
    ? execution
    : null;
}

/**
 * The defaults a run of `agentId` falls back to for whatever its request left
 * out.
 *
 * When the project is stamped for this agent, the stamp is the whole answer:
 * a stamp without a model means the CLI's own default, and a later change to
 * the global `agentModels` must not reach the project. Otherwise (unstamped,
 * or the run was explicitly sent to a different agent) this is today's
 * behaviour: the saved app-config model and no reasoning / service tier.
 */
export function resolveRunExecutionDefaults(
  agentId: string | null | undefined,
  project: ProjectExecutionHolder | null | undefined,
  appConfig: ProjectExecutionAppConfig | null | undefined,
): RunExecutionDefaults {
  const stamp = projectExecutionForAgent(agentId, project);
  if (stamp) {
    return {
      source: 'project',
      model: stamp.model ?? null,
      reasoning: stamp.reasoning ?? null,
      serviceTier: stamp.serviceTier ?? null,
    };
  }
  const savedModel = typeof agentId === 'string'
    ? appConfig?.agentModels?.[agentId]?.model
    : undefined;
  return {
    source: 'app-config',
    model: typeof savedModel === 'string' ? savedModel : null,
    reasoning: null,
    serviceTier: null,
  };
}

/**
 * The reasoning level / service tier a run inherits from its project's stamp
 * for fields its request left out.
 *
 * Inherited only when the stamp governs this agent and the run will use the
 * stamp's model (the request named no model, or named the stamp's own):
 * reasoning levels are model-specific and a service tier can re-pick the
 * model, so neither may ride along onto a model the caller chose explicitly.
 */
export function inheritedRunPrefsFromProjectExecution(
  agentId: string | null | undefined,
  project: ProjectExecutionHolder | null | undefined,
  request: { model?: unknown; reasoning?: unknown; serviceTier?: unknown },
): { reasoning?: string; serviceTier?: string } {
  const stamp = projectExecutionForAgent(agentId, project);
  if (!stamp) return {};
  const requestedModel = typeof request.model === 'string' ? request.model : null;
  const runsOnStampModel = requestedModel === null
    || requestedModel === (stamp.model ?? 'default');
  if (!runsOnStampModel) return {};
  const inherited: { reasoning?: string; serviceTier?: string } = {};
  const hasValue = (value: unknown) => typeof value === 'string' && value.length > 0;
  if (!hasValue(request.reasoning) && stamp.reasoning) inherited.reasoning = stamp.reasoning;
  if (!hasValue(request.serviceTier) && stamp.serviceTier) inherited.serviceTier = stamp.serviceTier;
  return inherited;
}
