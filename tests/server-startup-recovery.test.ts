import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

test('rejected future database leaves data intact and releases the startup lock for a later attempt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'noah-startup-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'noah.sqlite');
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=6; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('preserve');");
  db.close();
  const original = readFileSync(file);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(startServer({ dataDir: directory, port: 0, modelCheck: false }), /版本|更新/);
    assert.deepEqual(readFileSync(file), original);
    assert.equal(existsSync(join(directory, 'server.lock')), false);
    assert.equal(existsSync(join(directory, 'connection.json')), false);
  }
});
