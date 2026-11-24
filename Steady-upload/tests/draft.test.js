import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSaver } from '../public/draft.js';

test('autosave waits 850 milliseconds and queues an edit made during a save', async () => {
  let scheduled, input = 'first', release;
  const writes = [];
  const draft = draftSaver({
    read: () => input,
    async write(value) {
      writes.push(value);
      if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    },
    report() {},
    schedule(callback, duration) { scheduled = callback; assert.equal(duration, 850); },
    cancel() {}
  });
  draft.change();
  assert.deepEqual(writes, []);
  const pending = scheduled();
  input = 'second';
  draft.change();
  assert.equal(draft.dirty, true);
  release();
  assert.equal(await pending, true);
  assert.deepEqual(writes, ['first', 'second']);
  assert.equal(draft.dirty, false);
});

test('rapid typing coalesces and a lost response leaves the draft dirty until retry', async () => {
  const writes = [];
  const reports = [];
  const timers = new Set();
  let value = 'a';
  let offline = true;
  const saver = draftSaver({
    read: () => value,
    async write(text) {
      writes.push(text);
      if (offline) throw new Error('Connection closed after submitting');
    },
    report: message => reports.push(message),
    schedule(callback) { timers.add(callback); return callback; },
    cancel(callback) { timers.delete(callback); }
  });
  saver.change();
  value = 'ab';
  saver.change();
  assert.equal(timers.size, 1);
  assert.equal(await [...timers][0](), false);
  value = 'abc';
  saver.change();
  assert.match(reports.at(-1), /Couldn't save/);
  assert.equal(saver.dirty, true);
  assert.deepEqual(writes, ['ab']);
  offline = false;
  assert.equal(await saver.flush(), true);
  assert.deepEqual(writes, ['ab', 'ab', 'abc']);
  assert.equal(reports.at(-1), 'Saved');
  assert.equal(saver.dirty, false);
});

test('autosave retains failed changes for retry and refuses to overwrite a stale version', async () => {
  let error = new Error('Offline');
  const reports = [];
  const draft = draftSaver({
    read: () => 'draft',
    async write() { if (error) throw error; },
    report(message) { reports.push(message); },
    schedule() {}, cancel() {}
  });
  draft.change();
  assert.equal(await draft.flush(), false);
  assert.equal(draft.dirty, true);
  assert.match(reports.at(-1), /Offline/);
  error = null;
  assert.equal(await draft.flush(), true);
  assert.equal(draft.dirty, false);
  error = Object.assign(new Error('Changed elsewhere'), { status: 409 });
  draft.change();
  assert.equal(await draft.flush(), false);
  error = null;
  assert.equal(await draft.flush(), false);
  assert.equal(draft.dirty, true);
});

