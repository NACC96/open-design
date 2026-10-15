import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createCommandInvocation } from '@open-design/platform';

export type CodexCredentialStore = 'file' | 'keyring' | 'auto' | 'ephemeral';
export interface CodexAuthConfig {
  credentialStore: CodexCredentialStore;
  /** Selects direct OS-keyring versus encrypted local secrets storage. */
  secretAuthStorage?: boolean;
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
  return {
    credentialStore: value,
    ...(typeof secretAuthStorage === 'boolean' ? { secretAuthStorage } : {}),
  };
}

export function codexAuthConfigArgs(config: CodexAuthConfig): string[] {
  return [
    '-c', `cli_auth_credentials_store="${config.credentialStore}"`,
    ...(config.secretAuthStorage == null ? [] : ['-c', `features.secret_auth_storage=${config.secretAuthStorage}`]),
  ];
}

/**
 * Ask Codex for its non-secret credential-store selection. Its config
 * API applies user/system/managed layers without us parsing auth files or
 * copying arbitrary user configuration into the isolated image invocation.
 * This read-only process never starts a thread or an agent turn.
 */
export function readCodexAuthConfig(input: {
  command: string;
  env: NodeJS.ProcessEnv;
}): Promise<CodexAuthConfig> {
  const invocation = createCommandInvocation({
    ...input,
    args: ['app-server', '--stdio', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps'],
  });
  return new Promise((resolve, reject) => {
    let authConfig: CodexAuthConfig | undefined;
    let failed = false;
    let phase: 'initialize' | 'config' | 'done' = 'initialize';
    const child = execFile(invocation.command, invocation.args, {
      env: input.env,
      timeout: CONFIG_READ_TIMEOUT_MS,
      maxBuffer: 1_048_576,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }, (error) => {
      lines.close();
      if (error || failed || !authConfig) {
        // Do not expose stdout/stderr: config/read can contain unrelated
        // private settings. Only allowlisted auth-routing settings leave here.
        reject(new Error('Could not resolve the Codex credential store. Check your Codex CLI configuration and try again.'));
      } else resolve(authConfig);
    });
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
