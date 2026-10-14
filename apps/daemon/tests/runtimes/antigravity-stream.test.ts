// Replays recorded `agy 1.3.4 --output-format stream-json` stdout through the
// daemon's Antigravity parser. There is no agy mock under `mocks/`, so these
// recordings are the replay coverage for this parser; see
// tests/fixtures/antigravity-cli-recordings/README.md for provenance.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';

type StreamEvent = Record<string, unknown>;

const RECORDINGS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/antigravity-cli-recordings',
);

function recording(name: string): string {
  return readFileSync(path.join(RECORDINGS, name), 'utf8');
}

function replay(stdout: string, chunkSize = stdout.length): StreamEvent[] {
  const events: StreamEvent[] = [];
  const handler = createJsonEventStreamHandler('antigravity', (event) => events.push(event));
  for (let offset = 0; offset < stdout.length; offset += chunkSize) {
    handler.feed(stdout.slice(offset, offset + chunkSize));
  }
  handler.flush();
  return events;
}

function visibleText(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
}

test('a text → tool → text turn shows the reply once, not again from the result frame', () => {
  const stdout = recording('agy-1.3.4-text-tool-text.ndjson');
  for (const chunkSize of [stdout.length, 13]) {
    const events = replay(stdout, chunkSize);
    expect(visibleText(events)).toBe('Checking.\nDone.\n');
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_result')).toMatchObject([
      { toolUseId: '00000000-0000-4000-8000-0000000000a1:2', isError: false },
    ]);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  }
});

test('a final response step with no text does not replay the whole turn', () => {
  // Same turn, but the closing response step streamed nothing, so
  // `result.response` holds only what step 1 already streamed.
  const frames = recording('agy-1.3.4-text-tool-text.ndjson')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const frame of frames) {
    if (frame.step_update?.step_index === 3) delete frame.step_update.text_delta;
    if (frame.event === 'result') frame.result.response = 'Checking.\n';
  }
  const events = replay(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`);
  expect(visibleText(events)).toBe('Checking.\n');
});

test('the result frame still contributes text that was never streamed', () => {
  const events = replay([
    JSON.stringify({ event: 'step_update', step_update: {
      step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Part one. ',
    } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Part one. Part two.' } }),
    '',
  ].join('\n'));
  expect(visibleText(events)).toBe('Part one. Part two.');
});

test('a tool that ends in ERROR closes its row with the error text', () => {
  const events = replay(recording('agy-1.3.4-tool-error.ndjson'));
  const toolUse = events.find((event) => event.type === 'tool_use');
  expect(toolUse).toMatchObject({
    id: '00000000-0000-4000-8000-0000000000a2:2',
    name: 'view_file',
  });
  const results = events.filter((event) => event.type === 'tool_result');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ toolUseId: toolUse?.id, isError: true });
  expect(String(results[0]?.content)).toContain('no such file or directory');
  expect(visibleText(events)).toBe('DONE\n');
});

test('an interrupted result surfaces as a parser error frame', () => {
  // The parser reports what agy said. Whether the daemon shows it depends on
  // who stopped the process: a teardown the daemon started itself is not an
  // agent failure (covered in antigravity-progress.test.ts).
  const events = replay(recording('agy-1.3.4-interrupted.ndjson'));
  expect(events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: 'interrupted' },
  ]);
  expect(events.find((event) => event.type === 'usage')).toMatchObject({ isError: true });
});
