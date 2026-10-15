// Codex Subscription image renderer (`codex-gpt-image-2`).
//
// Every coding agent reaches this renderer through the media dispatcher; no
// Codex-specific chat prompt or project filesystem allowlist is needed. The
// supported CLI owns authentication and its built-in image tool. We import the
// generated image bytes into the project and remove the Codex copy only after
// that write succeeds. Read-only subprocess evidence stays under the resolved
// daemon data root. Quiet/slow renders are never killed by a wall-clock timer.

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createCommandInvocation } from '@open-design/platform';
import {
  applyAgentLaunchEnv,
  getAgentDef,
  resolveAgentLaunch,
  spawnEnvForAgent,
} from '../agents.js';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { isSandboxModeEnabled } from '../sandbox-mode.js';
import { readCodexAuthConfig, codexAuthConfigArgs, type CodexAuthConfig } from './codex-auth-config.js';
import {
  codexHomeFromEnv,
  resolveCodexSubscriptionStatus,
  type CodexSubscriptionStatus,
} from './config.js';

/** Codex image tool label used in provider notes (`codex/gpt-image-2`). */
const CODEX_IMAGE_TOOL_MODEL = 'gpt-image-2';
const LOGIN_STATUS_TIMEOUT_MS = 15_000;
const OUTPUT_TAIL_CHARS = 64_000;
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  '.png': '.png',
  '.jpg': '.jpg',
  '.jpeg': '.jpg',
  '.webp': '.webp',
};
/** API-key env vars a subscription render must never hand to Codex. */
const API_KEY_ENV_VARS = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

export const CODEX_CLI_UNAVAILABLE = 'CODEX_CLI_UNAVAILABLE';
export const CODEX_AUTH_REQUIRED = 'CODEX_AUTH_REQUIRED';

/** A Codex render failure carrying the stable code media triage keys on. */
export class CodexImagegenError extends Error {
  code: string | undefined;
  retryable: boolean | undefined;
  constructor(message: string, options: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'CodexImagegenError';
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export interface CodexImageRenderInput {
  prompt: string;
  aspect: string | undefined;
  imageRefs: ReadonlyArray<{ abs: string }>;
  /** Resolved daemon data root, for app-config `agentCliEnv.codex` overrides. */
  dataDir: string | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

export interface CodexImageRenderResult {
  bytes: Buffer;
  providerNote: string;
  suggestedExt: string;
  /** Called only after the project file has been written successfully. */
  cleanup: () => Promise<void>;
}

interface CodexLaunch {
  command: string | null;
  env: NodeJS.ProcessEnv;
}

async function resolveCodexLaunch(dataDir: string | undefined): Promise<CodexLaunch> {
  const def = getAgentDef('codex');
  let configuredEnv: Record<string, string> = {};
  if (dataDir) {
    try {
      configuredEnv = agentCliEnvForAgent((await readAppConfig(dataDir)).agentCliEnv, 'codex');
    } catch {
      configuredEnv = {};
    }
  }
  const launch = def ? resolveAgentLaunch(def, configuredEnv) : null;
  const env = applyAgentLaunchEnv(
    spawnEnvForAgent('codex', process.env, configuredEnv, undefined, {
      resolvedBin: launch?.selectedPath ?? null,
    }),
    launch ?? { childPathPrepend: [] },
  );
  for (const key of API_KEY_ENV_VARS) delete env[key];
  env.CODEX_HOME = codexHomeFromEnv(env);
  if (dataDir) env.OD_DATA_DIR = dataDir;
  return { command: launch?.launchPath ?? null, env };
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  threadId: string | null;
}

/** Durable evidence before stdin is sent; no timeout or stdin-based liveness. */
function runCodex(
  launch: CodexLaunch & { command: string },
  args: string[],
  options: { cwd: string; stdin: string; runDir: string },
): Promise<ProcessResult> {
  const invocation = createCommandInvocation({ command: launch.command, args, env: launch.env });
  const eventsPath = path.join(options.runDir, 'events.jsonl');
  const stderrPath = path.join(options.runDir, 'stderr.txt');
  const metadataPath = path.join(options.runDir, 'metadata.json');
  const metadata = {
    command: invocation.command, args: invocation.args, cwd: options.cwd,
    startedAt: new Date().toISOString(), pid: null as number | null,
    threadId: null as string | null, endedAt: null as string | null,
    exitCode: null as number | null, signal: null as NodeJS.Signals | null,
  };
  const saveMetadata = () => writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  writeFileSync(eventsPath, '', { mode: 0o600 });
  writeFileSync(stderrPath, '', { mode: 0o600 });
  saveMetadata();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    let evidenceError: unknown;
    // A disk error must not abandon or interrupt a still-running Codex process.
    const record = (write: () => void) => { try { write(); } catch (err) { evidenceError = err; } };
    metadata.pid = child.pid ?? null;
    record(() => {
      writeFileSync(path.join(options.runDir, 'pid'), String(metadata.pid), { mode: 0o600 });
      saveMetadata();
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-OUTPUT_TAIL_CHARS);
      record(() => appendFileSync(eventsPath, chunk));
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_TAIL_CHARS);
      record(() => appendFileSync(stderrPath, chunk));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (metadata.threadId) return;
      const threadId = parseCodexThreadId(line);
      if (threadId && SAFE_THREAD_ID.test(threadId)) {
        metadata.threadId = threadId;
        record(saveMetadata);
      }
    });
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') evidenceError = err;
    });
    child.once('error', (err) => { evidenceError = err; });
    child.once('close', (code, signal) => {
      lines.close();
      metadata.endedAt = new Date().toISOString();
      metadata.exitCode = code;
      metadata.signal = signal;
      record(saveMetadata);
      if (evidenceError) reject(evidenceError);
      else resolve({ code, signal, stdout, stderr, threadId: metadata.threadId });
    });
    child.stdin.end(options.stdin);
  });
}

async function probeCodexLoginStatus(
  launch: CodexLaunch & { command: string },
  authConfig: CodexAuthConfig,
): Promise<string | null> {
  const invocation = createCommandInvocation({
    command: launch.command,
    args: ['login', 'status', ...codexAuthConfigArgs(authConfig)],
    env: launch.env,
  });
  return new Promise((resolve) => {
    // This bounded status command does not start a generation or agent turn.
    execFile(invocation.command, invocation.args, {
      env: launch.env, timeout: LOGIN_STATUS_TIMEOUT_MS, maxBuffer: OUTPUT_TAIL_CHARS,
      windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }, (error, stdout, stderr) => resolve(error ? null : `${stdout}\n${stderr}`));
  });
}

/**
 * Readiness of the Codex Subscription route: installed and signed in with
 * ChatGPT. Checked before every render so a missing CLI or login fails with a
 * sentence that names the fix instead of a spawn error.
 */
async function codexReadiness(launch: CodexLaunch): Promise<{
  status: CodexSubscriptionStatus;
  authConfig?: CodexAuthConfig;
}> {
  const command = launch.command;
  if (!command || isSandboxModeEnabled(process.env)) {
    return { status: await resolveCodexSubscriptionStatus({ codexInstalled: Boolean(command) }) };
  }
  const authConfig = await readCodexAuthConfig({ ...launch, command });
  return {
    authConfig,
    status: await resolveCodexSubscriptionStatus({
      codexInstalled: true,
      probeLoginStatus: () => probeCodexLoginStatus({ ...launch, command }, authConfig),
    }),
  };
}

function aspectSizeHint(aspect: string | undefined): string {
  switch (aspect) {
    case '1:1':
      return '1:1 (square)';
    case '16:9':
    case '4:3':
      return `${aspect} (landscape)`;
    case '9:16':
    case '3:4':
      return `${aspect} (portrait)`;
    default:
      return aspect ? aspect : '1:1 (square)';
  }
}

/**
 * The instruction sent to `codex exec`. `$imagegen` mentions Codex's bundled
 * image-generation skill; the rest pins it to one built-in `image_gen` call
 * and forbids the API-key CLI fallback, follow-up questions, and moving the
 * saved file (the daemon imports it from `generated_images/`).
 */
export function codexImagegenPrompt(input: {
  prompt: string;
  aspect: string | undefined;
  referenceCount: number;
}): string {
  const lines = [
    '$imagegen Generate exactly one image with the built-in image_gen tool, then stop.',
    '',
    "This is a non-interactive request from Open Design's media dispatcher:",
    '- Call the built-in image_gen tool exactly once. Do not ask questions, spawn agents, run shell commands, or write scripts.',
    '- Never use the scripts/image_gen.py fallback or any API key.',
    "- Do not copy, move, rename, or edit the generated file. Leave it where image_gen saved it; Open Design imports it.",
    '- After the tool returns, reply with one short sentence.',
    '',
    `Aspect ratio: ${aspectSizeHint(input.aspect)}.`,
  ];
  if (input.referenceCount > 0) {
    lines.push(
      input.referenceCount === 1
        ? 'The attached image is the reference for this image: edit it or follow it as the prompt says.'
        : `The ${input.referenceCount} attached images are references for this image: use them as the prompt says.`,
    );
  }
  lines.push('', 'Image prompt:', input.prompt.trim() || 'A high-quality reference image.');
  return `${lines.join('\n')}\n`;
}

/** Build the `codex exec` argv. The prompt travels on stdin. */
export function codexImagegenArgs(input: {
  workDir: string;
  imageRefs: ReadonlyArray<{ abs: string }>;
  model?: string | undefined;
  authConfig?: CodexAuthConfig | undefined;
}): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'read-only',
    '-C',
    input.workDir,
    '-c', 'forced_login_method="chatgpt"',
    ...codexAuthConfigArgs(input.authConfig ?? { credentialStore: 'file' }),
    '--disable', 'hooks',
    '--disable', 'plugins',
    '--disable', 'apps',
    '--disable', 'shell_tool',
    '--disable', 'multi_agent',
  ];
  if (input.model) args.push('--model', input.model);
  for (const ref of input.imageRefs) args.push('--image', ref.abs);
  args.push('-');
  return args;
}

/** The `thread_id` from Codex's `thread.started` JSONL event, if any. */
export function parseCodexThreadId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: unknown; thread_id?: unknown };
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        return event.thread_id;
      }
    } catch {
      // Non-JSON progress lines are not events.
    }
  }
  return null;
}

/** Last `agent_message` text, so a refusal or explanation reaches the error. */
function lastAgentMessage(stdout: string): string {
  let last = '';
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { item?: { type?: unknown; text?: unknown } };
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        last = event.item.text.trim();
      }
    } catch {
      // ignore
    }
  }
  return last;
}

function tail(text: string, max = 800): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/**
 * The image Codex saved for this thread. Every file in the directory belongs
 * to this run (the thread id is new), so any supported image counts; the
 * newest wins if the model iterated. Codex has used several basename schemes
 * (`ig_*`, `call_*`, and `exec-*` in 0.162), so none is assumed.
 */
async function findGeneratedImage(threadDir: string): Promise<{ file: string; ext: string } | null> {
  let entries: string[];
  try {
    if (!(await lstat(threadDir)).isDirectory()) return null;
    entries = await readdir(threadDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  let best: { file: string; ext: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    const ext = IMAGE_EXTENSIONS[path.extname(name).toLowerCase()];
    if (!ext) continue;
    const file = path.join(threadDir, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size === 0) continue;
    if (!best || info.mtimeMs > best.mtimeMs) best = { file, ext, mtimeMs: info.mtimeMs };
  }
  return best ? { file: best.file, ext: best.ext } : null;
}

export async function renderCodexImage(input: CodexImageRenderInput): Promise<CodexImageRenderResult> {
  const launch = await resolveCodexLaunch(input.dataDir);
  const command = launch.command;
  const { status, authConfig } = await codexReadiness(launch);
  if (!status.available || !command) {
    throw new CodexImagegenError(status.message, {
      code: status.reason === 'not-installed' || status.reason === 'sandbox'
        ? CODEX_CLI_UNAVAILABLE
        : CODEX_AUTH_REQUIRED,
      retryable: false,
    });
  }

  if (!input.dataDir) throw new Error('Codex image generation requires the resolved daemon data root');
  const model = launch.env.OD_CODEX_IMAGEGEN_MODEL?.trim() || undefined;
  const runsDir = path.join(input.dataDir, 'media', 'codex-runs');
  await mkdir(runsDir, { recursive: true });
  const runDir = await mkdtemp(path.join(runsDir, 'render-'));
  const workDir = path.join(runDir, 'work');
  await mkdir(workDir);
  let threadDir: string | null = null;
  try {
    input.onProgress?.('Generating with Codex (ChatGPT subscription)…');
    const result = await runCodex(
      { ...launch, command },
      codexImagegenArgs({ workDir, imageRefs: input.imageRefs, model, authConfig }),
      {
        cwd: workDir,
        stdin: codexImagegenPrompt({
          prompt: input.prompt,
          aspect: input.aspect,
          referenceCount: input.imageRefs.length,
        }),
        runDir,
      },
    );
    const threadId = result.threadId;
    if (threadId && SAFE_THREAD_ID.test(threadId)) {
      threadDir = path.join(codexHomeFromEnv(launch.env), 'generated_images', threadId);
    }
    if (result.code !== 0) {
      const detail = tail(result.stderr || result.stdout) || 'no output';
      const rateLimited = /\b(usage limit|rate limit|too many requests)\b/i.test(detail);
      throw new CodexImagegenError(
        `codex imagegen exited ${result.signal ?? result.code}: ${detail}`,
        rateLimited ? { code: 'RATE_LIMITED', retryable: true } : {},
      );
    }
    if (!threadDir) {
      throw new CodexImagegenError(
        `codex imagegen did not report a thread id, so its saved image cannot be located. ${tail(result.stdout, 400)}`,
      );
    }
    const image = await findGeneratedImage(threadDir);
    if (!image) {
      const said = lastAgentMessage(result.stdout);
      throw new CodexImagegenError(
        `codex imagegen finished without saving an image under ${threadDir}.${said ? ` Codex said: ${tail(said, 400)}` : ''}`,
      );
    }
    const bytes = await readFile(image.file);
    return {
      bytes,
      providerNote: `codex/${CODEX_IMAGE_TOOL_MODEL} · ${input.aspect ?? '1:1'} · ${bytes.length} bytes`,
      suggestedExt: image.ext,
      cleanup: () => rm(threadDir!, { recursive: true, force: true }).catch(() => {}),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
