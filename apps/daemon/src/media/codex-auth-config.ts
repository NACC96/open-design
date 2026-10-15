import { createInterface } from 'node:readline';
import { spawnOwnedCodexProcess } from './codex-process.js';

export type CodexCredentialStore = 'file' | 'keyring' | 'auto' | 'ephemeral';
export interface CodexAuthConfig {
  credentialStore: CodexCredentialStore;
  /** Selects direct OS-keyring versus encrypted local secrets storage. */
  secretAuthStorage?: boolean;
  chatgptBaseUrl?: string;
  forcedChatgptWorkspaceId?: string | string[];
  respectSystemProxy?: boolean;
  systemProxyFallback?: boolean;
  psp?: boolean;
}

const CONFIG_READ_TIMEOUT_MS = 15_000;

function authConfigFromResult(result: unknown): CodexAuthConfig {
  if (result == null || typeof result !== 'object' || !('config' in result)
    || result.config == null || typeof result.config !== 'object') {
    throw new Error('Codex returned no configuration');
  }
  const config = result.config as Record<string, unknown>;
  const value = config.cli_auth_credentials_store ?? 'file';
  // Codex's documented default is file. Do not substitute auto: it can select
  // another account when file and keyring both contain credentials.
  if (value !== 'file' && value !== 'keyring' && value !== 'auto' && value !== 'ephemeral') {
    throw new Error('Codex returned an unsupported credential store');
  }
  const features = config.features;
  const secretAuthStorage = features != null && typeof features === 'object'
    ? (features as Record<string, unknown>).secret_auth_storage : undefined;
  if (secretAuthStorage != null && typeof secretAuthStorage !== 'boolean') {
    throw new Error('Codex returned an unsupported keyring backend');
  }
  const chatgptBaseUrl = config.chatgpt_base_url;
  if (chatgptBaseUrl != null) {
    if (typeof chatgptBaseUrl !== 'string') throw new Error('Invalid ChatGPT route');
    const url = new URL(chatgptBaseUrl);
    // This adapter forwards routing, never credentials embedded in a URL.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('ChatGPT route must be an HTTP(S) URL without credentials, query, or fragment');
    }
  }
  const workspace = config.forced_chatgpt_workspace_id;
  const safeWorkspace = (value: unknown): value is string => typeof value === 'string' && !/[\x00-\x1f]/.test(value);
  if (workspace != null && !safeWorkspace(workspace)
    && !(Array.isArray(workspace) && workspace.every(safeWorkspace))) {
    throw new Error('Invalid ChatGPT workspace restriction');
  }
  // These are the effective HTTP routing features used by Config::auth_route_config
  // in Codex 0.162.1. Other feature flags and arbitrary config stay isolated.
  const routingFeatures: Pick<CodexAuthConfig, 'respectSystemProxy' | 'systemProxyFallback' | 'psp'> = {};
  for (const [key, target] of [
    ['respect_system_proxy', 'respectSystemProxy'],
    ['system_proxy_fallback', 'systemProxyFallback'],
    ['psp', 'psp'],
  ] as const) {
    const flag = features != null && typeof features === 'object'
      ? (features as Record<string, unknown>)[key] : undefined;
    if (flag != null && typeof flag !== 'boolean') throw new Error('Invalid auth routing feature');
    if (typeof flag === 'boolean') routingFeatures[target] = flag;
  }
  return {
    credentialStore: value,
    ...(typeof secretAuthStorage === 'boolean' ? { secretAuthStorage } : {}),
    ...(typeof chatgptBaseUrl === 'string' ? { chatgptBaseUrl } : {}),
    ...(workspace != null ? { forcedChatgptWorkspaceId: workspace as string | string[] } : {}),
    ...routingFeatures,
  };
}

export function codexAuthConfigArgs(config: CodexAuthConfig): string[] {
  const args = [
    '-c', 'forced_login_method="chatgpt"',
    '-c', `cli_auth_credentials_store="${config.credentialStore}"`,
  ];
  for (const [key, value] of [
    ['features.secret_auth_storage', config.secretAuthStorage],
    ['chatgpt_base_url', config.chatgptBaseUrl],
    ['forced_chatgpt_workspace_id', config.forcedChatgptWorkspaceId],
    ['features.respect_system_proxy', config.respectSystemProxy],
    ['features.system_proxy_fallback', config.systemProxyFallback],
    ['features.psp', config.psp],
  ] as const) {
    if (value != null) args.push('-c', `${key}=${JSON.stringify(value)}`);
  }
  return args;
}

/** Retain the fact that a route was pinned without persisting private URLs/IDs. */
export function redactCodexAuthArgs(args: readonly string[]): string[] {
  return args.map(arg => arg.replace(/^(chatgpt_base_url|forced_chatgpt_workspace_id)=.*$/s, '$1="<redacted>"'));
}

/**
 * Ask Codex for its non-secret credential-store and authentication-route selection. Its config
 * API applies user/system/managed layers without us parsing auth files or
 * copying arbitrary user configuration into the isolated image invocation.
 * This read-only process never starts a thread or an agent turn.
 */
export function readCodexAuthConfig(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
}): Promise<CodexAuthConfig> {
  const { child, completion } = spawnOwnedCodexProcess({
    ...input,
    args: ['app-server', '--stdio', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps'],
    query: { timeoutMs: CONFIG_READ_TIMEOUT_MS, maxOutputBytes: 1_048_576 },
  });
  return new Promise((resolve, reject) => {
    let authConfig: CodexAuthConfig | undefined;
    let failed = false;
    let phase: 'initialize' | 'config' | 'done' = 'initialize';
    const settle = (error: boolean) => {
      lines.close();
      if (input.signal?.aborted) {
        reject(input.signal.reason);
      } else if (error || failed || !authConfig) {
        // Never expose query stdout/stderr: they can contain private settings.
        reject(new Error('Could not resolve the Codex credential store. Check your Codex CLI configuration and try again.'));
      } else resolve(authConfig);
    };
    void completion.then(exit => settle(exit.code !== 0), () => settle(true));
    const lines = createInterface({ input: child.stdout! });
    const finish = () => { phase = 'done'; child.stdin?.end(); };
    const send = (message: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    child.stdin?.on('error', () => { failed = true; finish(); });
    lines.on('line', (line) => {
      if (phase === 'done') return;
      let frame: { id?: unknown; error?: unknown; result?: unknown };
      try { frame = JSON.parse(line); } catch { return; }
      if (frame == null || typeof frame !== 'object') return;
      if (frame.id !== (phase === 'initialize' ? 1 : 2)) return;
      if (frame.error != null) { failed = true; finish(); return; }
      if (phase === 'initialize') {
        phase = 'config';
        send({ method: 'initialized' });
        send({ id: 2, method: 'config/read', params: { includeLayers: false } });
      } else {
        try { authConfig = authConfigFromResult(frame.result); } catch { failed = true; }
        finish();
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'open_design_media', version: '1.0.0' },
    } });
  });
}
