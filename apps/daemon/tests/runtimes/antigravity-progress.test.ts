import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { __forTestEmitLiveArtifactEvent, startServer } from '../../src/server.js';

// Daemon-level coverage for Antigravity's two transports, driven by a fake
// `agy` on PATH. The streaming frames mirror the recorded agy 1.3.4 shapes in
// tests/fixtures/antigravity-cli-recordings/.
//
// Real time is deliberate here: the inactivity watchdog runs inside the
// daemon against a separate child process, and the behaviour under test is
// the interleaving of that child's output with the daemon's timer. A fake
// clock in this process cannot drive the child's timers without collapsing
// exactly that interleaving (docs/testing/test-efficiency.zh-CN.md, "时钟驱动
// 逻辑"). The margins are wide instead: progress frames arrive every
// PROGRESS_TICK_MS against a WATCHDOG_MS window (10x), and the test waits on
// completion signals (the run's SSE stream ending, the daemon deleting the
// per-run agy log in its close handler) rather than polling run status.

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type Run = {
  id: string;
  status: string;
  artifactCount?: number;
  artifactPaths?: string[];
};
type Scenario =
  | 'progress'
  | 'stall'
  | 'legacy'
  | 'quiet'
  | 'silent-quota'
  | 'silent-auth';

const WATCHDOG_MS = 1_000;
const PROGRESS_TICK_MS = 100;
const PROGRESS_TICKS = 13; // 1.3s of tool progress: longer than one watchdog window.
const QUIET_PERIOD_MS = 200;
const API_MODE_HEADING = '# API mode — no tools available';
// Handoff rules from the slim charter's two execution profiles
// (apps/daemon/src/prompts/core-slim.ts).
const TEXT_ARTIFACT_HANDOFF = 'The `<artifact>` block is the source of truth.';
const FILESYSTEM_HANDOFF = 'Project files are the source of truth.';

const envKeys = [
  'PATH',
  'OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS',
  'OD_CHAT_RUN_FIRST_OUTPUT_TIMEOUT_MS',
  'OD_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let started: StartedServer | null = null;
let binDir: string | null = null;

afterEach(async () => {
  await Promise.resolve(started?.shutdown?.());
  if (started?.server) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
  started = null;
  if (binDir) await rm(binDir, { recursive: true, force: true });
  binDir = null;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeAgyScript(scenario: Scenario, argvFile: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
if (args.includes('--version')) { console.log('1.3.4'); process.exit(0); }
if (args.includes('--help')) {
  console.log(scenario === 'legacy' ? '-p --log-file' : '-p --log-file --output-format text,json,stream-json');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
const logIdx = args.indexOf('--log-file');
if (logIdx !== -1) {
  const body = scenario === 'silent-quota'
    ? 'upstream error: code = 429 RESOURCE_EXHAUSTED: Individual quota reached'
    : scenario === 'silent-auth'
      ? 'error getting token source: You are not logged into Antigravity'
      : 'Propagating selected model override to backend: label="default"';
  fs.writeFileSync(args[logIdx + 1], body + '\\n');
}
const exitAfter = (text, code) => process.stdout.write(text, () => process.exit(code));
if (scenario === 'legacy') {
  if (args.includes('--output-format')) process.exit(2);
  exitAfter('Legacy reply.\\n', 0);
} else {
  if (!(args.includes('--output-format') && args.includes('stream-json'))) process.exit(2);
  const conversation = 'fake-agy';
  const frame = (event) => JSON.stringify(event) + '\\n';
  const emit = (event) => process.stdout.write(frame(event));
  const step = (index, fields) => emit({ event: 'step_update', step_update: {
    conversation_id: conversation, step_index: index, ...fields,
  } });
  // agy 1.3.4 reports its own termination as an error result and exits 1.
  process.on('SIGTERM', () => exitAfter(frame({ event: 'result', result: {
    conversation_id: conversation, status: 'ERROR', response: '', error: 'interrupted',
  } }), 1));
  emit({ event: 'init', conversation_id: conversation, init: {} });
  step(0, { step_type: 'user_input', state: 'DONE' });
  if (scenario === 'silent-quota' || scenario === 'silent-auth') {
    exitAfter(frame({ event: 'result', result: {
      conversation_id: conversation, status: 'SUCCESS', response: '',
    } }), 0);
  } else if (scenario === 'stall') {
    step(1, { step_type: 'tool', state: 'ACTIVE',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 600' } } });
    setInterval(() => {}, 60_000);
  } else if (scenario === 'quiet') {
    step(1, { step_type: 'agent_response', state: 'DONE', text_delta: 'Draft ready.' });
    setInterval(() => {}, 60_000);
  } else {
    // The deliverable is written by agy's own file tool, the way a real
    // streaming run edits the project.
    const file = path.join(process.cwd(), 'index.html');
    const write = { name: 'write_to_file', parameters: { TargetFile: file } };
    step(1, { step_type: 'tool', state: 'ACTIVE', tool_info: write });
    fs.writeFileSync(file, '<!doctype html><title>agy</title><p>ok</p>\\n');
    step(1, { step_type: 'tool', state: 'DONE', tool_info: { ...write, output: 'Created file' } });
    let tick = 1;
    const timer = setInterval(() => {
      tick++;
      step(tick, { step_type: 'tool', state: 'DONE',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo progress' }, output: 'working' } });
      if (tick === ${PROGRESS_TICKS}) {
        clearInterval(timer);
        step(tick + 1, { step_type: 'agent_response', state: 'DONE', text_delta: 'Validated streaming.' });
        exitAfter(frame({ event: 'result', result: {
          conversation_id: conversation, status: 'SUCCESS', response: 'Validated streaming.',
        } }), 0);
      }
    }, ${PROGRESS_TICK_MS});
  }
}
`;
}

/** Reads the run's SSE stream until the daemon ends it at the terminal state. */
async function readRunStream(
  url: string,
  runId: string,
  onText?: (soFar: string) => void,
): Promise<string> {
  const response = await fetch(`${url}/api/runs/${runId}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    onText?.(text);
  }
}

/** The close handler deletes the per-run agy log last, after every stdout frame. */
async function waitForCloseHandler(logFile: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (existsSync(logFile)) {
    if (Date.now() > deadline) throw new Error(`daemon never finished closing ${logFile}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runFakeAgy(
  scenario: Scenario,
  onStreamText?: (soFar: string, ids: { url: string; runId: string; projectId: string }) => void,
) {
  binDir = await mkdtemp(path.join(os.tmpdir(), 'od-agy-progress-'));
  const argvFile = path.join(binDir, 'argv.json');
  const bin = path.join(binDir, 'agy');
  await writeFile(bin, fakeAgyScript(scenario, argvFile));
  await chmod(bin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ''}`;
  process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = String(WATCHDOG_MS);
  process.env.OD_CHAT_RUN_FIRST_OUTPUT_TIMEOUT_MS = '0';
  process.env.OD_CHAT_RUN_ARTIFACT_QUIET_PERIOD_MS = String(QUIET_PERIOD_MS);
  started = await startServer({ port: 0, returnServer: true }) as StartedServer;
  const url = started.url;
  const headers = { 'content-type': 'application/json' };
  expect((await fetch(`${url}/api/app-config`, { method: 'PUT', headers, body: JSON.stringify({
    telemetry: { metrics: false, content: false, artifactManifest: false }, privacyDecisionAt: Date.now(),
  }) })).status).toBe(200);
  const projectId = `agy_progress_${randomUUID()}`;
  const project = await fetch(`${url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({
    id: projectId, name: 'Antigravity progress test', skipDiscoveryBrief: true,
  }) });
  expect(project.status).toBe(200);
  const { conversationId } = await project.json() as { conversationId: string };
  const response = await fetch(`${url}/api/runs`, { method: 'POST', headers, body: JSON.stringify({
    projectId, conversationId, assistantMessageId: randomUUID(), clientRequestId: randomUUID(),
    agentId: 'antigravity', model: 'default', message: 'test progress', currentPrompt: 'test progress',
  }) });
  expect(response.status).toBe(202);
  const { runId } = await response.json() as { runId: string };
  const streamed = await readRunStream(
    url,
    runId,
    onStreamText ? (soFar) => onStreamText(soFar, { url, runId, projectId }) : undefined,
  );
  const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
  const logFile = argv[argv.indexOf('--log-file') + 1]!;
  expect(argv).toContain('--log-file');
  await waitForCloseHandler(logFile);
  const run = await (await fetch(`${url}/api/runs/${runId}`)).json() as Run;
  // Replays every persisted event, including any the child caused after the
  // run went terminal (the live stream above had already ended by then).
  const events = await (await fetch(`${url}/api/runs/${runId}/events`)).text();
  return {
    run,
    streamed,
    events,
    argv,
    prompt: argv[argv.indexOf('-p') + 1] ?? '',
  };
}

function errorEventCount(events: string): number {
  return events.split('\n').filter((line) => line === 'event: error').length;
}

it('keeps a native tool-only run alive beyond the inactivity window until its final reply', async () => {
  const { run, events, argv, prompt } = await runFakeAgy('progress');
  expect(run.status).toBe('succeeded');
  expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
  expect(events).toContain('"streamFormat":"json-event-stream"');
  expect(events).toContain('"type":"tool_use"');
  expect(events).toContain('"type":"tool_result"');
  expect(events).toContain('Validated streaming.');
  expect(events).not.toContain('event: run_retry_attempted');
  expect(errorEventCount(events)).toBe(0);
  // The file agy's own write tool created is picked up by the daemon's
  // filesystem diff, not by stdout artifact extraction.
  expect(run.artifactPaths).toContain('index.html');
  expect(run.artifactCount).toBeGreaterThanOrEqual(1);
  // Prompt and transport come from one decision: a streaming run gets the
  // filesystem execution profile and no API-mode override.
  expect(prompt).toContain(FILESYSTEM_HANDOFF);
  expect(prompt).not.toContain(TEXT_ARTIFACT_HANDOFF);
  expect(prompt).not.toContain(API_MODE_HEADING);
});

it('times out a truly stalled native tool run once, without replaying work or echoing the kill', async () => {
  const { run, events } = await runFakeAgy('stall');
  expect(run.status).toBe('failed');
  expect(events).toContain('"type":"tool_use"');
  expect(events).toContain('inactivity_timeout');
  expect(events).not.toContain('event: run_retry_attempted');
  // agy answers the watchdog's SIGTERM with an "interrupted" error result;
  // that echo of our own teardown must not become a second error.
  expect(errorEventCount(events)).toBe(1);
  expect(events).not.toContain('interrupted');
});

it('keeps a delivered run succeeded when the artifact quiet period stops agy', async () => {
  let triggered = false;
  const { run, events } = await runFakeAgy('quiet', (soFar, { runId, projectId }) => {
    if (triggered || !soFar.includes('Draft ready.')) return;
    triggered = true;
    // The same hook a live-artifact create fires: it switches the run onto
    // the short quiet-period window, after which the daemon stops agy.
    __forTestEmitLiveArtifactEvent({ runId, projectId }, 'created', {
      id: 'agy-live-artifact', projectId, title: 'Draft',
    });
  });
  expect(triggered).toBe(true);
  expect(run.status).toBe('succeeded');
  expect(errorEventCount(events)).toBe(0);
  expect(events).not.toContain('interrupted');
});

it('keeps older Antigravity CLIs on the plain-text path with the API-mode prompt', async () => {
  const { run, events, argv, prompt } = await runFakeAgy('legacy');
  expect(run.status).toBe('succeeded');
  expect(argv).not.toContain('--output-format');
  expect(events).toContain('"streamFormat":"plain"');
  expect(events).toContain('Legacy reply.');
  // Prompt and transport come from one decision: plain stdout gets the
  // text-artifact (API mode) prompt, not the filesystem execution profile.
  expect(prompt).toContain(API_MODE_HEADING);
  expect(prompt).toContain(TEXT_ARTIFACT_HANDOFF);
  expect(prompt).not.toContain(FILESYSTEM_HANDOFF);
});

it.each([
  { scenario: 'silent-quota' as const, code: 'RATE_LIMITED', guidance: 'quota' },
  { scenario: 'silent-auth' as const, code: 'AGENT_AUTH_REQUIRED', guidance: 'sign in' },
])('routes a silent streaming exit to the agy log verdict ($code)', async ({ scenario, code, guidance }) => {
  const { run, events } = await runFakeAgy(scenario);
  expect(run.status).toBe('failed');
  expect(events).toContain(`"code":"${code}"`);
  expect(events.toLowerCase()).toContain(guidance);
  expect(events).not.toContain('Agent completed without producing any output');
});
