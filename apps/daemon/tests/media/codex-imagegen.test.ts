import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Socket } from 'node:net';
import { isProcessAlive, waitForProcessExit } from '@open-design/platform';
import { createInterface } from 'node:readline';
import { mediaFailureNextStep } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../../src/media/index.js';
import { createCodexImageService } from '../../src/media/codex-image-service.js';
import {
  codexImagegenArgs,
  codexImagegenPrompt,
  parseCodexThreadId,
} from '../../src/media/codex-imagegen.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';
const ENV_KEYS = [
  'CODEX_BIN',
  'CODEX_HOME',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OD_DATA_DIR',
  'OD_MEDIA_CONFIG_DIR',
  'OD_MEDIA_ALLOW_STUBS',
  'OD_SANDBOX_MODE',
  'OD_CODEX_IMAGEGEN_MODEL',
] as const;

type FakeCodexOptions = {
  /** Basename Codex 0.162 uses is `exec-<uuid>.png`; older builds used `ig_*`. */
  outputFileName?: string | null;
  threadId?: string;
  loginStatus?: string;
  loginStatusExit?: number;
  exitCode?: number;
  stderr?: string;
  agentMessage?: string;
  extraOutput?: string;
  credentials?: { file?: string; keyring?: string; secrets?: string };
  configReadError?: boolean;
  changeStoreAfterRead?: string;
  authRouting?: Record<string, unknown>;
  controlPort?: number;
  probeControlPhase?: 'config' | 'login';
};

/**
 * A stand-in for the Codex CLI. `codex login status` prints a canned answer;
 * `codex exec` records its argv, stdin and API-key env to `calls.jsonl`, writes
 * an image into `$CODEX_HOME/generated_images/<thread>/` the way the built-in
 * image_gen tool does, and prints the JSONL events `codex exec --json` emits.
 */
async function installFakeCodex(root: string, options: FakeCodexOptions = {}): Promise<{
  bin: string;
  calls: () => Promise<Array<{ args: string[]; stdin: string; env: Record<string, string | null>; store: string; account?: string }>>;
  invocations: () => Promise<Array<{ args: string[]; store: string; account?: string }>>;
}> {
  const bin = path.join(root, `fake-codex-${Math.random().toString(36).slice(2)}.mjs`);
  const callsFile = path.join(root, 'calls.jsonl');
  const invocationsFile = path.join(root, 'invocations.jsonl');
  const config = {
    callsFile,
    invocationsFile,
    credentials: options.credentials,
    configReadError: options.configReadError,
    changeStoreAfterRead: options.changeStoreAfterRead,
    authRouting: options.authRouting,
    controlPort: options.controlPort,
    probeControlPhase: options.probeControlPhase,
    png: PNG_BASE64,
    outputFileName: options.outputFileName === undefined
      ? 'exec-0d4c4e7e-6a0e-4bb4-9a37-1b2f3c4d5e6f.png'
      : options.outputFileName,
    threadId: options.threadId ?? '01a14066-7a67-7fb2-88a5-3fea78180a29',
    loginStatus: options.loginStatus ?? 'Logged in using ChatGPT',
    loginStatusExit: options.loginStatusExit ?? 0,
    exitCode: options.exitCode ?? 0,
    stderr: options.stderr ?? '',
    agentMessage: options.agentMessage ?? 'Generated one image.',
    extraOutput: options.extraOutput ?? '',
  };
  await writeFile(bin, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';

const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
async function holdReadinessProbe() {
  // The descendant acknowledges readiness; the wrapper holds TERM until release. The test
  // controls exit over the socket, exposing an early-settlement bug without sleep.
  const descendant = spawn(process.execPath, ['-e',
    "process.on('message', () => process.exit(0)); process.send('ready'); setInterval(() => {}, 1000);"
  ], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  await new Promise(resolve => descendant.once('message', resolve));
  const control = createConnection(config.controlPort, '127.0.0.1');
  const exited = new Promise(resolve => descendant.once('exit', () => {
    control.write(JSON.stringify({event: 'descendant-exit'}) + '\\n');
    resolve();
  }));
  const onTerm = () => control.write(JSON.stringify({event: 'term'}) + '\\n');
  process.on('SIGTERM', onTerm);
  control.once('connect', () => control.write(JSON.stringify({pid: process.pid, descendantPid: descendant.pid}) + '\\n'));
  await new Promise(resolve => control.once('data', resolve));
  if (descendant.exitCode === null && descendant.signalCode === null) descendant.send('finish');
  await exited;
  process.off('SIGTERM', onTerm);
  control.end();
}
const configFile = path.join(process.env.CODEX_HOME, 'config.toml');
let userConfig = '';
try { userConfig = readFileSync(configFile, 'utf8'); } catch {}
const configuredStore = /^cli_auth_credentials_store\\s*=\\s*"([^"\\n]+)"/m.exec(userConfig)?.[1];
const configuredSecrets = /^secret_auth_storage\\s*=\\s*(true|false)/m.exec(userConfig)?.[1];
let secrets = args.includes('--ignore-user-config') ? process.platform === 'win32' : (configuredSecrets ? configuredSecrets === 'true' : process.platform === 'win32');
let store = args.includes('--ignore-user-config') ? 'file' : (configuredStore ?? 'file');
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] !== '-c') continue;
  const match = /^cli_auth_credentials_store="([^"]+)"$/.exec(args[i + 1]);
  if (match) store = match[1];
  const secretMatch = /^features[.]secret_auth_storage=(true|false)$/.exec(args[i + 1]);
  if (secretMatch) secrets = secretMatch[1] === 'true';
}
const keyringAccount = secrets ? config.credentials?.secrets : config.credentials?.keyring;
const account = config.credentials
  ? (store === 'auto' ? (keyringAccount ?? config.credentials.file) : store === 'keyring' ? keyringAccount : config.credentials[store])
  : 'default-test-account';
appendFileSync(config.invocationsFile, JSON.stringify({args, store, account}) + '\\n');
if (args[0] === 'app-server') {
  const lines = createInterface({input: process.stdin});
  lines.on('line', async line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({id: request.id, result: {userAgent: 'fake-codex'}}) + '\\n');
    }
    if (request.method === 'config/read') {
      if (config.probeControlPhase === 'config') await holdReadinessProbe();
      const response = config.configReadError
        ? {error: {code: -32603, message: 'fake config failure'}}
        : {result: {config: {...config.authRouting, cli_auth_credentials_store: configuredStore ?? null, features: {...config.authRouting?.features, ...(configuredSecrets ? {secret_auth_storage: configuredSecrets === 'true'} : {})}, unrelated_secret: 'MUST_NOT_COPY_CONFIG'}, origins: {}}};
      process.stdout.write(JSON.stringify({id: request.id, ...response}) + '\\n');
      if (config.changeStoreAfterRead) {
        writeFileSync(configFile, 'cli_auth_credentials_store = "' + config.changeStoreAfterRead + '"\\n');
      }
    }
  });
} else if (args[0] === 'login' && args[1] === 'status') {
  if (config.probeControlPhase === 'login') await holdReadinessProbe();
  process.stdout.write((account ? config.loginStatus : 'Not logged in') + '\\n');
  process.exitCode = account ? config.loginStatusExit : 1;
} else {
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', async () => {
  appendFileSync(config.callsFile, JSON.stringify({
    args,
    stdin,
    store,
    account,
    env: {
      CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      CODEX_HOME: process.env.CODEX_HOME ?? null,
    },
  }) + '\\n');
  if (!account) {
    process.stderr.write('No credentials in selected ' + store + ' store');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: config.threadId }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
  process.stdout.write(config.extraOutput);
  if (config.controlPort && !config.probeControlPhase) {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    const control = createConnection(config.controlPort, '127.0.0.1');
    control.once('connect', () => control.write(JSON.stringify({pid: process.pid, descendantPid: descendant.pid}) + '\\n'));
    await new Promise(resolve => control.once('data', resolve));
    const exited = new Promise(resolve => descendant.once('exit', resolve));
    descendant.kill('SIGTERM');
    await exited;
    control.end();
  }
  if (config.outputFileName) {
    const dir = path.join(process.env.CODEX_HOME, 'generated_images', config.threadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, config.outputFileName), Buffer.from(config.png, 'base64'));
  }
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: config.agentMessage } }) + '\\n');
  if (config.stderr) process.stderr.write(config.stderr);
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
  process.exitCode = config.exitCode;
});
}
`, 'utf8');
  await chmod(bin, 0o755);
  return {
    bin,
    invocations: async () => {
      const raw = await readFile(invocationsFile, 'utf8').catch(() => '');
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    calls: async () => {
      const raw = await readFile(callsFile, 'utf8').catch(() => '');
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

async function renderControl() {
  type ActiveFixture = { socket: Socket; pid: number; descendantPid: number };
  let resolve!: (active: ActiveFixture) => void;
  const ready = new Promise<ActiveFixture>(done => { resolve = done; });
  let onTerm!: () => void;
  const terminationRequested = new Promise<void>(resolve => { onTerm = resolve; });
  let onDescendantExit!: () => void;
  const descendantExited = new Promise<void>(resolve => { onDescendantExit = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    createInterface({input: socket}).on('line', line => {
      const event = JSON.parse(line);
      if (event.event === 'term') onTerm();
      else if (event.event === 'descendant-exit') onDescendantExit();
      else resolve({socket, ...event});
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as {port: number}).port,
    ready,
    terminationRequested,
    waitForDescendantExit: () => new Promise<void>((resolve, reject) => {
      // Failure deadline for a real process boundary, not a readiness sleep.
      const timer = setTimeout(() => reject(new Error('descendant was not reaped')), 5_000);
      void descendantExited.then(() => { clearTimeout(timer); resolve(); });
    }),
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function writeCodexAuth(codexHome: string, data: unknown) {
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(data), 'utf8');
}

describe('Codex Subscription image provider', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  let codexHome: string;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-codex-imagegen-test-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    codexHome = path.join(root, 'codex-home');
    await mkdir(projectsRoot, { recursive: true });
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(root, { recursive: true, force: true });
  });

  function generate(overrides: Partial<Parameters<typeof generateMedia>[0]> = {}) {
    return generateMedia({
      projectRoot,
      dataDir: path.join(root, 'data-root'),
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'codex-gpt-image-2',
      prompt: 'A compact green app icon with a folded page motif',
      output: 'codex.png',
      ...overrides,
    });
  }

  it('does not start Codex when the owning daemon has already shut down', async () => {
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;
    const controller = new AbortController();
    controller.abort(new Error('daemon shutdown'));
    await expect(generate({ signal: controller.signal })).rejects.toThrow('daemon shutdown');
    expect(await fake.invocations()).toEqual([]);
  });

  it.each(['config', 'login'] as const)('awaits %s probe closure and its owned descendant during shutdown', async probeControlPhase => {
    const control = await renderControl();
    const service = createCodexImageService();
    const fake = await installFakeCodex(root, {controlPort: control.port, probeControlPhase});
    process.env.CODEX_BIN = fake.bin;
    const rendering = generate({codexImageRenderer: service.render}).then(() => null, error => error as Error);
    const active = await control.ready;
    let shutdownReturned = false;
    const shuttingDown = service.shutdownActive().then(() => { shutdownReturned = true; });
    try {
      await control.terminationRequested;
      expect(isProcessAlive(active.pid)).toBe(true);
      expect(shutdownReturned, 'shutdown must wait for close, not the abort callback').toBe(false);
      await control.waitForDescendantExit();
      expect(isProcessAlive(active.descendantPid)).toBe(false);
      expect(shutdownReturned).toBe(false);
      active.socket.write('finish');
      await shuttingDown;
      expect((await rendering)?.message).toContain('daemon shutdown');
      expect(isProcessAlive(active.pid)).toBe(false);
      expect(isProcessAlive(active.descendantPid)).toBe(false);
      expect(await fake.calls()).toEqual([]);
    } finally {
      active.socket.write('finish');
      await shuttingDown;
      await rendering;
      await Promise.all([waitForProcessExit(active.pid), waitForProcessExit(active.descendantPid)]);
      await control.close();
    }
  });

  it.each(['config', 'login'] as const)('allows the %s query to complete normally before generation', async probeControlPhase => {
    const control = await renderControl();
    const service = createCodexImageService();
    const fake = await installFakeCodex(root, {controlPort: control.port, probeControlPhase});
    process.env.CODEX_BIN = fake.bin;
    const rendering = generate({codexImageRenderer: service.render});
    const active = await control.ready;
    try {
      expect(await fake.calls()).toEqual([]);
      active.socket.write('finish');
      const result = await rendering;
      expect(result.providerId).toBe('codex');
      expect(isProcessAlive(active.pid)).toBe(false);
      expect(isProcessAlive(active.descendantPid)).toBe(false);
      expect(await fake.calls()).toHaveLength(1);
    } finally {
      active.socket.write('finish');
      await service.shutdownActive();
      await rendering.catch(() => {});
      await control.close();
    }
  });

  it('reaps the render and its descendant on explicit shutdown before resolving', async () => {
    const control = await renderControl();
    const service = createCodexImageService();
    const fake = await installFakeCodex(root, { controlPort: control.port });
    process.env.CODEX_BIN = fake.bin;
    const rendering = generate({ codexImageRenderer: service.render }).then(() => null, error => error as Error);
    try {
      const active = await control.ready;
      expect(isProcessAlive(active.pid)).toBe(true);
      expect(isProcessAlive(active.descendantPid)).toBe(true);
      await service.shutdownActive();
      expect((await rendering)?.message).toContain('daemon shutdown');
      expect(isProcessAlive(active.pid)).toBe(false);
      expect(isProcessAlive(active.descendantPid)).toBe(false);
      await service.shutdownActive();
      const before = (await fake.invocations()).length;
      await expect(generate({ codexImageRenderer: service.render })).rejects.toThrow('daemon shutdown');
      expect(await fake.invocations()).toHaveLength(before);
    } finally {
      await service.shutdownActive();
      await rendering;
      await control.close();
    }
  });

  it('keeps a quiet render alive until it finishes normally and releases its ownership', async () => {
    const control = await renderControl();
    const service = createCodexImageService();
    process.env.CODEX_BIN = (await installFakeCodex(root, { controlPort: control.port })).bin;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rendering = generate({ codexImageRenderer: service.render });
    try {
      const active = await control.ready;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(isProcessAlive(active.pid)).toBe(true);
      vi.useRealTimers();
      active.socket.write('finish');
      const result = await rendering;
      expect(result.providerId).toBe('codex');
      expect(result.usedStubFallback).toBe(false);
      expect(isProcessAlive(active.pid)).toBe(false);
      expect(isProcessAlive(active.descendantPid)).toBe(false);
      await service.shutdownActive();
      const runsDir = path.join(root, 'data-root', 'media', 'codex-runs');
      const [run] = await readdir(runsDir);
      const metadata = JSON.parse(await readFile(path.join(runsDir, run!, 'metadata.json'), 'utf8'));
      expect(metadata).toMatchObject({exitCode: 0, signal: null});
    } finally {
      vi.useRealTimers();
      await service.shutdownActive();
      await rendering.catch(() => {});
      await control.close();
    }
  });

  it('renders codex-gpt-image-2 through a headless, isolated codex exec and imports the image', async () => {
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;

    const result = await generate({ aspect: '16:9' });

    expect(result.providerId).toBe('codex');
    expect(result.providerNote).toContain('codex/gpt-image-2');
    expect(result.usedStubFallback).toBe(false);
    const bytes = await readFile(path.join(projectsRoot, 'project-1', result.name));
    expect(bytes.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);

    const [call] = await fake.calls();
    expect(call!.args.slice(0, 8)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--sandbox',
      'read-only',
      '-C',
    ]);
    // The working directory is an empty temp dir, never the project.
    expect(call!.args[8]).not.toContain(projectRoot);
    expect(call!.stdin).toContain('$imagegen');
    expect(call!.stdin).toContain('A compact green app icon with a folded page motif');
    expect(call!.stdin).toContain('16:9 (landscape');
    expect(call!.stdin).toContain('Never use the scripts/image_gen.py fallback or any API key');

    // The Codex copy is removed once the project owns the bytes.
    await expect(stat(path.join(codexHome, 'generated_images', '01a14066-7a67-7fb2-88a5-3fea78180a29')))
      .rejects.toThrow();
  });

  it('routes a project saved with a removed Cloud image model through Codex', async () => {
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt' });
    process.env.CODEX_BIN = (await installFakeCodex(root)).bin;

    const result = await generate({ model: 'vela/gpt-image-2', output: 'legacy.png' });

    expect(result.providerId).toBe('codex');
    expect(result.model).toBe('vela/gpt-image-2');
    await expect(readFile(path.join(projectsRoot, 'project-1', 'legacy.png'))).resolves.toBeTruthy();
  });

  it.each(['ig_0001.png', 'call_Er2KDML8Fof5QcOXdSovI85V.png', 'image.webp'])(
    'imports the saved image whatever Codex named it (%s)',
    async (outputFileName) => {
      await writeCodexAuth(codexHome, { tokens: { access_token: 'codex-oauth-token' } });
      process.env.CODEX_BIN = (await installFakeCodex(root, { outputFileName })).bin;

      const result = await generate();

      expect(result.providerId).toBe('codex');
      expect(result.name).toBe(`codex${path.extname(outputFileName)}`);
    },
  );

  it('never hands an API key to Codex', async () => {
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt' });
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;
    process.env.CODEX_API_KEY = 'sk-codex-should-not-leak';
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-leak';

    await generate();

    const [call] = await fake.calls();
    expect(call!.env.CODEX_API_KEY).toBeNull();
    expect(call!.env.OPENAI_API_KEY).toBeNull();
  });

  it('attaches project reference images with --image', async () => {
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt' });
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;
    const projectDir = path.join(projectsRoot, 'project-1');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'ref.png'), Buffer.from(PNG_BASE64, 'base64'));

    await generate({ image: 'ref.png', output: 'edited.png' });

    const [call] = await fake.calls();
    const imageIndex = call!.args.indexOf('--image');
    expect(imageIndex).toBeGreaterThan(0);
    expect(call!.args[imageIndex + 1]).toBe(path.join(projectDir, 'ref.png'));
    expect(call!.stdin).toContain('The attached image is the reference');
  });

  it.each(['codex-gpt-image-2', 'vela/gpt-image-2'])('rejects six distinct references for %s before any Codex process starts', async model => {
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;
    const projectDir = path.join(projectsRoot, 'project-1');
    await mkdir(projectDir, { recursive: true });
    const images = Array.from({ length: 6 }, (_, i) => `ref-${i}.png`);
    await Promise.all(images.map(name => writeFile(path.join(projectDir, name), Buffer.from(PNG_BASE64, 'base64'))));

    await expect(generate({ model, images })).rejects.toThrow(/at most 5.*Remove.*retry/);
    expect(await fake.invocations()).toEqual([]);
  });

  it('accepts five distinct references and deduplicates repeated primary references', async () => {
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;
    const projectDir = path.join(projectsRoot, 'project-1');
    await mkdir(projectDir, { recursive: true });
    const images = Array.from({ length: 5 }, (_, i) => `ref-${i}.png`);
    await Promise.all(images.map(name => writeFile(path.join(projectDir, name), Buffer.from(PNG_BASE64, 'base64'))));

    await generate({ image: images[0]!, images: [...images, images[0]!] });
    const [call] = await fake.calls();
    expect(call!.args.filter(arg => arg === '--image')).toHaveLength(5);
  });

  it('honours app-config Codex CLI overrides from the daemon data root', async () => {
    const dataDir = path.join(root, 'data-root');
    const configuredHome = path.join(root, 'configured-codex-home');
    await writeCodexAuth(configuredHome, { auth_mode: 'chatgpt' });
    const fake = await installFakeCodex(root);
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify({
      agentCliEnv: { codex: { CODEX_BIN: fake.bin, CODEX_HOME: configuredHome } },
    }), 'utf8');
    // The process-level CODEX_HOME has no login: only the configured one does.
    process.env.CODEX_HOME = path.join(root, 'wrong-codex-home');

    const result = await generate({ dataDir });

    expect(result.providerId).toBe('codex');
    const [call] = await fake.calls();
    expect(call!.env.CODEX_HOME).toBe(configuredHome);
  });

  it.each([
    { store: 'keyring', credentials: { keyring: 'keyring-user' }, expected: 'keyring-user' },
    { store: 'file', credentials: { file: 'file-user', keyring: 'different-user' }, expected: 'file-user' },
    { store: 'auto', credentials: { file: 'different-user', keyring: 'keyring-user' }, expected: 'keyring-user' },
    { store: 'auto', credentials: { file: 'file-user' }, expected: 'file-user' },
    { store: undefined, credentials: { file: 'file-user', keyring: 'different-user' }, expected: 'file-user' },
  ])('uses the same selected account for login and generation with $store ($expected)', async ({store, credentials, expected}) => {
    await mkdir(codexHome, { recursive: true });
    const configText = store ? `cli_auth_credentials_store = "${store}"\n` : '';
    await writeFile(path.join(codexHome, 'config.toml'), configText);
    const fake = await installFakeCodex(root, { credentials });
    process.env.CODEX_BIN = fake.bin;

    const result = await generate();

    expect(result.providerId).toBe('codex');
    const invocations = (await fake.invocations()).filter(call => ['login', 'exec'].includes(call.args[0]!));
    expect(invocations).toHaveLength(2);
    for (const call of invocations) {
      expect(call.store).toBe(store ?? 'file');
      expect(call.account).toBe(expected);
      expect(call.args).toContain(`cli_auth_credentials_store="${store ?? 'file'}"`);
      expect(call.args.join(' ')).not.toContain('MUST_NOT_COPY_CONFIG');
    }
    expect(invocations[1]!.args).toContain('--ignore-user-config');
    expect(await readFile(path.join(codexHome, 'config.toml'), 'utf8')).toBe(configText);
  });

  it('does not fall back to a file account when the explicit keyring has no login', async () => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const fake = await installFakeCodex(root, { credentials: { file: 'wrong-file-user' } });
    process.env.CODEX_BIN = fake.bin;
    await expect(generate()).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
    expect(await fake.calls()).toHaveLength(0);
  });

  it.each([true, false])('preserves the selected keyring backend with secret_auth_storage=%s', async (secrets) => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), `cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = ${secrets}\n`);
    const fake = await installFakeCodex(root, {
      credentials: { keyring: 'direct-keyring-user', secrets: 'encrypted-keyring-user' },
    });
    process.env.CODEX_BIN = fake.bin;
    await generate();
    const authCalls = (await fake.invocations()).filter(call => ['login', 'exec'].includes(call.args[0]!));
    expect(authCalls.map(call => call.account)).toEqual(Array(2).fill(secrets ? 'encrypted-keyring-user' : 'direct-keyring-user'));
    expect(authCalls.every(call => call.args.includes(`features.secret_auth_storage=${secrets}`))).toBe(true);
  });

  it('pins the resolved store even if config changes between the read and login check', async () => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const fake = await installFakeCodex(root, {
      credentials: { file: 'different-user', keyring: 'selected-user' }, changeStoreAfterRead: 'file',
    });
    process.env.CODEX_BIN = fake.bin;
    await generate();
    const authCalls = (await fake.invocations()).filter(call => ['login', 'exec'].includes(call.args[0]!));
    expect(authCalls.map(call => call.account)).toEqual(['selected-user', 'selected-user']);
  });

  it.each(['config-error', 'unknown-store'])('fails closed on %s instead of guessing a credential store', async failure => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "unknown"\n');
    const fake = await installFakeCodex(root, { configReadError: failure === 'config-error' });
    process.env.CODEX_BIN = fake.bin;
    await expect(generate()).rejects.toThrow(/credential store/);
    expect(await fake.calls()).toHaveLength(0);
    expect((await fake.invocations()).some(call => call.args[0] === 'login')).toBe(false);
  });

  it('preserves only supported auth routing for login and generation, and redacts command evidence', async () => {
    const fake = await installFakeCodex(root, { authRouting: {
      chatgpt_base_url: 'https://chat.example.test/private-routing/backend-api/',
      forced_chatgpt_workspace_id: ['workspace-one', 'workspace-two'],
      features: { respect_system_proxy: true, system_proxy_fallback: false, psp: true, shell_tool: true },
      model_provider: 'MUST_NOT_COPY_CONFIG',
    } });
    process.env.CODEX_BIN = fake.bin;
    await generate();
    const authCalls = (await fake.invocations()).filter(call => ['login', 'exec'].includes(call.args[0]!));
    for (const call of authCalls) {
      expect(call.args).toContain('chatgpt_base_url="https://chat.example.test/private-routing/backend-api/"');
      expect(call.args).toContain('forced_chatgpt_workspace_id=["workspace-one","workspace-two"]');
      expect(call.args).toContain('features.respect_system_proxy=true');
      expect(call.args).toContain('features.system_proxy_fallback=false');
      expect(call.args).toContain('features.psp=true');
      expect(call.args).toContain('forced_login_method="chatgpt"');
      expect(call.args.join(' ')).not.toContain('MUST_NOT_COPY_CONFIG');
      expect(call.args).not.toContain('features.shell_tool=true');
    }
    const runsDir = path.join(root, 'data-root', 'media', 'codex-runs');
    const [run] = await readdir(runsDir);
    const metadata = await readFile(path.join(runsDir, run!, 'metadata.json'), 'utf8');
    expect(metadata).not.toContain('private-routing');
    expect(metadata).not.toContain('workspace-one');
    expect(metadata).toContain('chatgpt_base_url');
  });

  it.each([
    { chatgpt_base_url: 'https://user:secret@example.test/backend-api' },
    { chatgpt_base_url: 'https://example.test/?token=secret' },
    { chatgpt_base_url: 'https://example.test/#secret' },
    { chatgpt_base_url: 'file:///private/backend-api' },
    { forced_chatgpt_workspace_id: 12 },
    { features: { respect_system_proxy: 'yes' } },
  ])('refuses malformed or credential-bearing auth routing before login or rendering: %j', async authRouting => {
    const fake = await installFakeCodex(root, { authRouting });
    process.env.CODEX_BIN = fake.bin;
    await expect(generate()).rejects.toThrow(/Codex/);
    expect((await fake.invocations()).map(call => call.args[0])).toEqual(['app-server']);
  });

  it('refuses to run when Codex is signed out, naming the fix', async () => {
    const fake = await installFakeCodex(root, { loginStatus: 'Not logged in', loginStatusExit: 1 });
    process.env.CODEX_BIN = fake.bin;

    const failure = await generate().catch((err) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/Codex is not signed in\. Run `codex login`/);
    expect(failure.code).toBe('CODEX_AUTH_REQUIRED');
    expect(mediaFailureNextStep({ code: failure.code, message: failure.message })).toBe('sign-in');
    expect(await fake.calls()).toHaveLength(0);
  });

  it('refuses an API-key-only Codex login instead of spending the key', async () => {
    await writeCodexAuth(codexHome, { OPENAI_API_KEY: 'sk-codex-api-key' });
    const fake = await installFakeCodex(root, { loginStatus: 'Logged in using an API key' });
    process.env.CODEX_BIN = fake.bin;

    const failure = await generate().catch((err) => err);

    expect(failure.message).toMatch(/signed in with an API key, not a ChatGPT subscription/);
    expect(failure.code).toBe('CODEX_AUTH_REQUIRED');
    expect(await fake.calls()).toHaveLength(0);
  });

  it('refuses in sandbox mode without reading the Codex login', async () => {
    process.env.OD_SANDBOX_MODE = '1';
    process.env.OD_DATA_DIR = path.join(root, 'sandbox-data');
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt' });
    const fake = await installFakeCodex(root);
    process.env.CODEX_BIN = fake.bin;

    const failure = await generate().catch((err) => err);

    expect(failure.message).toMatch(/unavailable in sandbox mode/);
    expect(failure.code).toBe('CODEX_CLI_UNAVAILABLE');
    expect(await fake.calls()).toHaveLength(0);
  });

  it('reports a run that saved no image with what Codex said', async () => {
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt' });
    process.env.CODEX_BIN = (await installFakeCodex(root, {
      outputFileName: null,
      agentMessage: 'I cannot generate that image.',
    })).bin;

    await expect(generate()).rejects.toThrow(
      /finished without saving an image .*Codex said: I cannot generate that image\./,
    );
    await expect(readdir(path.join(projectsRoot, 'project-1'))).resolves.not.toContain('codex.png');
  });

  it('classifies a subscription usage limit as retry-later', async () => {
    await writeCodexAuth(codexHome, { auth_mode: 'chatgpt' });
    process.env.CODEX_BIN = (await installFakeCodex(root, {
      outputFileName: null,
      exitCode: 1,
      stderr: "ERROR: You've hit your usage limit. Try again later.",
    })).bin;

    const failure = await generate().catch((err) => err);

    expect(failure.message).toMatch(/codex imagegen exited 1: .*usage limit/);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(mediaFailureNextStep({ code: failure.code, message: failure.message })).toBe('retry-later');
  });

  it('retains the thread id and observable evidence when output exceeds the diagnostic tail', async () => {
    process.env.CODEX_BIN = (await installFakeCodex(root, { extraOutput: 'x'.repeat(80_000) + '\n' })).bin;
    const result = await generate();
    expect(result.providerId).toBe('codex');
    const runsDir = path.join(root, 'data-root', 'media', 'codex-runs');
    const [run] = await readdir(runsDir);
    const runDir = path.join(runsDir, run!);
    const metadata = JSON.parse(await readFile(path.join(runDir, 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      threadId: '01a14066-7a67-7fb2-88a5-3fea78180a29', exitCode: 0,
      cwd: path.join(runDir, 'work'),
    });
    expect(metadata.pid).toBeGreaterThan(0);
    expect(metadata.endedAt).toBeTruthy();
    expect(await readFile(path.join(runDir, 'pid'), 'utf8')).toBe(String(metadata.pid));
    expect((await stat(path.join(runDir, 'events.jsonl'))).size).toBeGreaterThan(80_000);
    await expect(stat(metadata.cwd)).rejects.toThrow();
  });

  it('preserves the generated source image if the project file cannot be written', async () => {
    process.env.CODEX_BIN = (await installFakeCodex(root)).bin;
    await mkdir(path.join(projectsRoot, 'project-1', 'codex.png'), { recursive: true });
    await expect(generate()).rejects.toThrow();
    const files = await readdir(path.join(codexHome, 'generated_images', '01a14066-7a67-7fb2-88a5-3fea78180a29'));
    expect(files).toHaveLength(1);
  });

  it('never turns a Codex auth failure into a successful placeholder', async () => {
    process.env.CODEX_BIN = (await installFakeCodex(root, { loginStatus: 'Not logged in', loginStatusExit: 1 })).bin;
    process.env.OD_MEDIA_ALLOW_STUBS = '1';
    await expect(generate()).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
  });

});

describe('codex imagegen invocation', () => {
  it('builds an isolated exec argv and keeps the prompt on stdin', () => {
    expect(codexImagegenArgs({
      workDir: '/tmp/od-codex-imagegen-x',
      imageRefs: [{ abs: '/p/a.png' }, { abs: '/p/b.png' }],
      model: 'gpt-6.1-sol',
    })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
      '--sandbox', 'read-only', '-C', '/tmp/od-codex-imagegen-x',
      '-c', 'forced_login_method="chatgpt"',
      '-c', 'cli_auth_credentials_store="file"',
      '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps',
      '--disable', 'shell_tool', '--disable', 'multi_agent',
      '--model', 'gpt-6.1-sol',
      '--image', '/p/a.png', '--image', '/p/b.png', '-',
    ]);
  });

  it('pins one built-in image_gen call and the requested aspect', () => {
    const prompt = codexImagegenPrompt({ prompt: 'A red kite', aspect: '9:16', referenceCount: 0 });
    expect(prompt.startsWith('$imagegen ')).toBe(true);
    expect(prompt).toContain('Call the built-in image_gen tool exactly once');
    expect(prompt).toContain('Aspect ratio: 9:16 (portrait).');
    expect(prompt.trimEnd().endsWith('A red kite')).toBe(true);
  });

  it('reads the thread id from the thread.started event only', () => {
    expect(parseCodexThreadId([
      'not json',
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'thread.started', thread_id: 'abc-123' }),
    ].join('\n'))).toBe('abc-123');
    expect(parseCodexThreadId(JSON.stringify({ type: 'turn.completed' }))).toBeNull();
  });
});
