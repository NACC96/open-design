import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  getProject,
  insertProject,
  listUnboundProjects,
  openDatabase,
  parseProjectExecutionJson,
  updateProject,
} from '../src/db.js';

let tempDir = '';

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function freshDb() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-project-execution-'));
  return openDatabase(tempDir, { dataDir: tempDir });
}

const stamp = { agentId: 'codex', model: 'gpt-5-codex', reasoning: 'high' };

function seed(db: ReturnType<typeof openDatabase>, execution: unknown = stamp) {
  insertProject(db, {
    id: 'p1',
    name: 'Project',
    metadata: { kind: 'prototype', nameSource: 'generated' },
    execution,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe('projects.execution_json', () => {
  it('round-trips a stamp through insert and every project read', () => {
    const db = freshDb();
    seed(db);
    expect(getProject(db, 'p1')?.execution).toEqual(stamp);
    expect(listUnboundProjects(db).find((p) => p.id === 'p1')?.execution).toEqual(stamp);
  });

  it('reads an unstamped project as having no execution', () => {
    const db = freshDb();
    seed(db, null);
    expect(getProject(db, 'p1')?.execution).toBeUndefined();
  });

  it('keeps the stamp on a rename', () => {
    const db = freshDb();
    seed(db);
    expect(updateProject(db, 'p1', { name: 'Renamed' })?.execution).toEqual(stamp);
  });

  it('keeps the stamp on a whole-metadata patch from a stale snapshot', () => {
    const db = freshDb();
    seed(db);
    const updated = updateProject(db, 'p1', { metadata: { kind: 'prototype', nameSource: 'user' } });
    expect(updated?.metadata).toEqual({ kind: 'prototype', nameSource: 'user' });
    expect(updated?.execution).toEqual(stamp);
  });

  it('keeps the stamp when a patch carries execution: undefined', () => {
    const db = freshDb();
    seed(db);
    expect(updateProject(db, 'p1', { execution: undefined })?.execution).toEqual(stamp);
  });

  it('replaces the stamp wholesale and clears it with null', () => {
    const db = freshDb();
    seed(db);
    expect(updateProject(db, 'p1', { execution: { agentId: 'claude' } })?.execution)
      .toEqual({ agentId: 'claude' });
    expect(updateProject(db, 'p1', { execution: null })?.execution).toBeUndefined();
    expect(getProject(db, 'p1')?.execution).toBeUndefined();
  });

  it('adds the column to a database created before it existed', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-project-execution-legacy-'));
    const legacy = new Database(path.join(tempDir, 'app.sqlite'));
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        skill_id TEXT,
        design_system_id TEXT,
        pending_prompt TEXT,
        metadata_json TEXT,
        custom_instructions TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('legacy', 'Legacy project', 1, 1);
    legacy.close();

    const db = openDatabase(tempDir, { dataDir: tempDir });
    const columns = (db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain('execution_json');
    expect(getProject(db, 'legacy')?.execution).toBeUndefined();
    expect(updateProject(db, 'legacy', { execution: stamp })?.execution).toEqual(stamp);
  });
});

describe('parseProjectExecutionJson', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['malformed JSON', '{"agentId":'],
    ['an array', '["codex"]'],
    ['a missing agent', '{"model":"gpt-5"}'],
    ['a non-string pref', '{"agentId":"codex","model":5}'],
  ])('reads %s as unstamped', (_label, raw) => {
    expect(parseProjectExecutionJson(raw)).toBeUndefined();
  });

  it('drops unknown keys and null prefs', () => {
    expect(parseProjectExecutionJson('{"agentId":"codex","model":null,"extra":true,"reasoning":"high"}'))
      .toEqual({ agentId: 'codex', reasoning: 'high' });
  });
});
