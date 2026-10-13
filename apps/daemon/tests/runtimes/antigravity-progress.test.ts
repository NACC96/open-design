import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type Run = { id: string; status: string; retryAttemptCount: number };
const envKeys = ['PATH', 'OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS', 'OD_CHAT_RUN_FIRST_OUTPUT_TIMEOUT_MS'];
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

async function runFakeAgy(scenario: 'progress' | 'stall' | 'legacy') {
  binDir = await mkdtemp(path.join(os.tmpdir(), 'od-agy-progress-'));
  const bin = path.join(binDir, 'agy');
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
if (args.includes('--version')) { console.log('1.3.4'); process.exit(0); }
if (args.includes('--help')) {
  console.log(scenario === 'legacy' ? '-p --log-file' : '-p --log-file --output-format text,json,stream-json');
  process.exit(0);
}
if (scenario === 'legacy') {
  if (args.includes('--output-format')) process.exit(2);
  console.log('Legacy reply.'); process.exit(0);
}
const streaming = args.includes('--output-format') && args.includes('stream-json');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
if (streaming) emit({event:'init', conversation_id:'fake-agy', init:{}});
let tick = 0;
const timer = setInterval(() => {
  tick++;
  if (streaming && (scenario === 'progress' || tick === 1)) emit({event:'step_update', step_update:{
    conversation_id:'fake-agy', step_index:tick, step_type:'tool', state:'DONE',
    tool_info:{name:'run_command', parameters:{CommandLine:'echo progress'}, output:'working'},
  }});
  if (tick === 7) {
    clearInterval(timer);
    if (streaming) emit({event:'result', result:{status:'SUCCESS', response:'Validated streaming.'}});
    else console.log('Validated streaming.');
  }
}, 400);
`);
  await chmod(bin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ''}`;
  process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '1000';
  process.env.OD_CHAT_RUN_FIRST_OUTPUT_TIMEOUT_MS = '0';
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
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const run = await (await fetch(`${url}/api/runs/${runId}`)).json() as Run;
    if (['failed', 'succeeded', 'canceled'].includes(run.status)) {
      const events = await (await fetch(`${url}/api/runs/${runId}/events`)).text();
      return { run, events };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fake Antigravity run did not finish');
}

it('keeps a native tool-only run alive beyond the inactivity window until its final reply', async () => {
  const { run, events } = await runFakeAgy('progress');
  expect(run.status).toBe('succeeded');
  expect(events).toContain('"type":"tool_use"');
  expect(events).toContain('"type":"tool_result"');
  expect(events).toContain('Validated streaming.');
  expect(events).not.toContain('event: run_retry_attempted');
});

it('times out a truly stalled native tool run without replaying work as a first-token retry', async () => {
  const { run, events } = await runFakeAgy('stall');
  expect(run.status).toBe('failed');
  expect(events).toContain('"type":"tool_use"');
  expect(events).toContain('inactivity_timeout');
  expect(events).not.toContain('event: run_retry_attempted');
});

it('keeps older Antigravity CLIs on the plain-text path without unsupported flags', async () => {
  const { run, events } = await runFakeAgy('legacy');
  expect(run.status).toBe('succeeded');
  expect(events).toContain('"streamFormat":"plain"');
  expect(events).toContain('Legacy reply.');
});
