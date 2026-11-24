import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SteadyModel, guidedId, quickReflectionId } from '../models/steady.js';
import { credentials, unlock, encryptBackup, decryptBackup, seal } from '../services/security.js';
import { localDay, offset, weekStart } from '../services/dates.js';

const master = 'Temporary sample master';
const backupPassword = 'Temporary backup sample';
const first = '2026-01-05';
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'steady-model-'));
  const file = join(folder, 'steady.sqlite');
  let clock = Date.parse(first + 'T06:00Z');
  let model = new SteadyModel(file, () => clock);
  model.setup({});
  const key = randomBytes(32);
  t.after(() => {
    model.db.close();
    key.fill(0);
    rmSync(folder, { recursive: true, force: true });
  });
  return {
    get model() { return model; }, key, file,
    move(day) { clock = Date.parse(day + 'T06:00Z'); model.materializeThrough(model.today()); },
    reopen() { model.db.close(); model = new SteadyModel(file, () => clock); }
  };
}

test('habit updates are prospective, completion is idempotent, and tracking survives restart', t => {
  const f = fixture(t);
  const id = f.model.habits()[0].id;
  f.model.saveHabit({ id, name: 'New name', minutes: 8, description: 'New description', active: false });
  f.model.saveHabit({ name: 'New habit', minutes: 7, description: '', active: true });
  const tomorrow = offset(first, 1);
  assert.equal(f.model.daily(first).habits[0].name, 'Physical Health');
  assert.equal(f.model.daily(first).habits[0].minutes, 10);
  assert.throws(() => f.model.setCompletion(tomorrow, id, true, first), /tracked date/);
  f.model.setCompletion(first, id, true, first);
  f.model.setCompletion(first, id, true, first);
  assert.equal(f.model.daily(first).done, 1);
  f.model.setCompletion(first, id, false, first);
  assert.equal(f.model.daily(first).done, 0);
  f.model.setCompletion(first, id, true, first);
  f.reopen();
  assert.equal(f.model.daily(first).percentage, 20);
  f.move(tomorrow);
  assert.ok(f.model.daily(tomorrow).habits.some(habit => habit.name === 'New habit'));
  assert.ok(f.model.daily(tomorrow).habits.every(habit => habit.habit !== id));
  f.model.saveHabit({ id, name: 'New name', minutes: 8, description: '', active: true });
  f.model.reorder(id, 'down');
  f.move(offset(first, 2));
  assert.equal(f.model.daily(offset(first, 2)).habits.find(habit => habit.habit === id).name, 'New name');
  f.model.setMood(first, 'Good', f.model.today());
  f.model.setMood(first, 'Great', f.model.today());
  assert.equal(f.model.daily(first).mood, 'Great');
  f.model.setMood(first, '', f.model.today());
  assert.equal(f.model.daily(first).mood, '');
  f.model.transaction(() => f.model.restoreDefaults());
  assert.equal(f.model.habits().find(habit => habit.id === id).name, 'Physical Health');
  assert.equal(f.model.daily(offset(first, 2)).habits.find(habit => habit.habit === id).name, 'New name');
});

test('backup restores deleted habits as hidden while preserving their history', t => {
  const source = fixture(t);
  const target = fixture(t);
  const [habit] = source.model.daily(first).habits;
  source.model.setCompletion(first, habit.habit, true, first);
  const nextDay = offset(first, 1);
  source.move(nextDay);
  source.model.deleteHabit(habit.habit, nextDay);
  target.model.restore(source.model.backup(source.key), target.key);
  assert.equal(target.model.habitSettings().some(row => row.id === habit.habit), false);
  assert.equal(target.model.daily(first).done, 1);
  assert.equal(target.model.daily(nextDay).total, 3);

  const legacy = source.model.backup(source.key);
  delete legacy.tables.deleted_habits;
  target.model.restore(legacy, target.key);
  assert.equal(target.model.daily(first).done, 1);
  assert.equal(target.model.habitSettings().find(row => row.id === habit.habit).active, 0);
});

test('journal modes coexist, search decrypts content, stale changes fail, and tampering is rejected', t => {
  const { model, key } = fixture(t);
  const generation = model.meta('generation');
  const id = 'a'.repeat(32);
  const guided = { day: first, mode: 'guided', version: 0, generation, accomplished: 'Made progress', difficult: '', tomorrow: '' };
  const free = { day: first, mode: 'free', version: 0, generation, title: 'Sample title', body: 'A private sample' };
  model.saveJournal(key, guidedId(first), guided, first);
  model.saveJournal(key, id, free, first);
  model.saveJournal(key, 'b'.repeat(32), { ...free, title: 'Another entry' }, first);
  assert.equal(model.journalList(key, first).length, 3);
  assert.equal(model.journalList(key, first, 'MaDe PrOg').length, 1);
  assert.equal(model.journalList(key, first, 'Sample title')[0].body, 'A private sample');
  const original = model.get('SELECT ciphertext FROM journals WHERE id=?', id).ciphertext;
  assert.ok(!original.includes('private sample'));
  assert.equal(model.saveJournal(key, id, { ...free, version: 1, body: 'Updated' }, first).version, 2);
  assert.throws(() => model.saveJournal(key, id, free, first), { status: 409 });
  model.transaction(() => model.deleteJournal(id, 2, generation, first));
  assert.equal(model.journalList(key, first).length, 2);
  model.run("UPDATE journals SET ciphertext='AAAA' WHERE id=?", guidedId(first));
  assert.throws(() => model.journalList(key, first), /Invalid ciphertext/);
});

test('statistics respect local day boundaries, incomplete today, no scheduled habits, and challenge endpoints', t => {
  const f = fixture(t);
  const complete = day => {
    for (const habit of f.model.daily(day).habits) f.model.setCompletion(day, habit.habit, true, f.model.today());
  };
  assert.equal(localDay(new Date('2026-01-04T16:00:00Z'), 'Asia/Singapore'), first);
  assert.equal(localDay(new Date('2026-01-04T16:00:00Z'), 'America/Los_Angeles'), '2026-01-04');
  complete(first);
  const tomorrow = offset(first, 1);
  f.move(tomorrow);
  assert.equal(f.model.statistics(tomorrow).current, 1);
  assert.equal(f.model.statistics(tomorrow).weekRate, 50);
  complete(tomorrow);
  for (const habit of f.model.habits()) f.model.saveHabit({ ...habit, active: false });
  const empty = offset(first, 2);
  f.move(empty);
  assert.equal(f.model.statistics(empty).current, 2);
  assert.equal(f.model.statistics(empty).tracked, 2);
  const day15 = offset(first, 14);
  f.move(day15);
  f.model.transaction(() => f.model.restoreDefaults());
  const day16 = offset(first, 15);
  f.move(day16);
  complete(day16);
  const stats = f.model.statistics(day16);
  assert.equal(stats.longest, 2);
  assert.equal(stats.current, 1);
  assert.equal(stats.fullDays, 3);
  assert.equal(stats.monthRate, 100);
  assert.equal(stats.habits[0].longest, 2);
  assert.deepEqual(stats.challenge, { started: first, end: offset(first, 13), goal: 11, completed: 2 });
  const calendar = f.model.calendar('2026-01', day16);
  assert.equal(calendar.cells.find(cell => cell.day === empty).state, 'unscheduled');
  assert.equal(calendar.cells.find(cell => cell.day === offset(day16, 1)).state, 'future');
  f.model.run('INSERT INTO challenges(started) VALUES (?)', day16);
  assert.equal(f.model.statistics(day16).challenge.completed, 1);
  assert.equal(f.model.statistics(day16).fullDays, 3);
});

test('calendar keeps journal markers separate and weekly progress distinguishes missing records', t => {
  const f = fixture(t);
  const week = offset(first, 7);
  const today = offset(week, 3);
  f.move(today);
  const { model, key } = f;
  const habit = model.habits()[0].id;
  model.setCompletion(first, habit, true, today);
  for (const item of model.daily(week).habits) model.setCompletion(week, item.habit, true, today);
  model.setCompletion(offset(week, 1), habit, true, today);
  model.setMood(offset(week, 2), 'Good', today);
  model.saveJournal(key, 'd'.repeat(32), { day: today, mode: 'free', title: '', body: 'Private test content',
    version: 0, generation: model.meta('generation') }, today);
  model.migrateWriting(key);
  const calendar = model.calendar('2026-01', today);
  const cell = day => calendar.cells.find(item => item.day === day);
  assert.equal(cell(week).state, 'full');
  assert.equal(cell(offset(week, 1)).state, 'partial');
  assert.equal(cell(offset(week, 2)).state, 'incomplete');
  assert.equal(cell(today).journal, true);
  assert.equal(cell(today).state, 'incomplete');
  assert.equal(cell(offset(week, -1)).state, 'unrecorded');
  assert.equal(cell(offset(today, 1)).state, 'future');
  assert.equal(weekStart('2026-01-01'), '2025-12-29');
  const summary = model.weeklySummary(week, today);
  assert.equal(summary.recordedDays, 3);
  assert.equal(summary.completions, 5);
  assert.deepEqual(summary.days.map(day => day.percentage), [100, 25, 0, null, null, null, null]);
  assert.equal(summary.days[4].upcoming, true);
  assert.equal(summary.habits[0].completed, 2);
  assert.equal(summary.moods.find(row => row.mood === 'Good').count, 1);
  assert.deepEqual(summary.comparison, { previousCompletions: 1, partial: true });
  assert.equal(model.weeklySummary(first, today).comparison, null);
  assert.doesNotMatch(JSON.stringify(summary), /Private test content/);
});

test('password change preserves the data key and authenticated backups restore atomically', async t => {
  const source = fixture(t);
  const target = fixture(t);
  const old = await credentials(master, source.key);
  assert.equal(await unlock('Wrong password', old), null);
  assert.deepEqual(await unlock(master, old), source.key);
  const next = await credentials('Different temporary master', source.key);
  assert.deepEqual(await unlock('Different temporary master', next), source.key);
  assert.notEqual(next.wrapped, old.wrapped);
  const id = 'c'.repeat(32);
  source.model.saveJournal(source.key, id, { day: first, mode: 'free', version: 0,
    generation: source.model.meta('generation'), title: 'Sample', body: 'A private backup sample' }, first);
  source.model.setMood(first, 'Great', first);
  const envelope = await encryptBackup(backupPassword, source.model.backup(source.key));
  assert.ok(!JSON.stringify(envelope).includes('private backup sample'));
  await assert.rejects(decryptBackup('Wrong backup password', envelope));
  const corrupt = Buffer.from(envelope.data, 'base64');
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(decryptBackup(backupPassword, { ...envelope, data: corrupt.toString('base64') }));
  const data = await decryptBackup(backupPassword, envelope);
  const broken = structuredClone(data);
  broken.tables.journals[0].ciphertext = 'AAAA';
  target.model.setMood(first, 'Difficult', first);
  assert.throws(() => target.model.restore(broken, target.key));
  assert.equal(target.model.daily(first).mood, 'Difficult');
  assert.equal(target.model.journalList(target.key).length, 0);
  target.model.restore(data, target.key);
  assert.equal(target.model.daily(first).mood, 'Great');
  assert.equal(target.model.journalList(target.key)[0].body, 'A private backup sample');
  assert.throws(() => target.model.journalList(source.key));
});

test('v1 migration and legacy encrypted restore preserve daily snapshots and journal records', async t => {
  const source = fixture(t);
  const target = fixture(t);
  const { key } = source;
  const habit = source.model.habits()[0].id;
  source.model.setCompletion(first, habit, true, first);
  const id = 'e'.repeat(32);
  source.model.saveJournal(key, id, { day: first, title: '', body: 'Existing encrypted entry', mode: 'free',
    version: 0, generation: source.model.meta('generation') }, first);
  const encrypted = source.model.get('SELECT ciphertext FROM journals WHERE id=?', id).ciphertext;
  const snapshots = source.model.daily(first).habits;
  const oldBackup = source.model.backup(key);
  oldBackup.version = 1;
  for (const name of ['daily_plans','habit_schedules','extra_completions','monthly_reflections']) delete oldBackup.tables[name];
  source.model.db.exec('DROP TABLE habit_icons; DROP TABLE deleted_habits; DROP TABLE personal_notes; DROP TABLE extra_completions; DROP TABLE monthly_reflections; DROP TABLE daily_plans; DROP TABLE habit_schedules; PRAGMA user_version=1');
  source.reopen();
  assert.equal(source.model.get('PRAGMA user_version').user_version, 6);
  assert.equal(source.model.get('SELECT ciphertext FROM journals WHERE id=?', id).ciphertext, encrypted);
  assert.deepEqual(source.model.daily(first).habits, snapshots);
  assert.equal(source.model.get('SELECT count(*) AS n FROM daily_plans').n, 4);
  const envelope = await encryptBackup(backupPassword, oldBackup);
  target.model.restore(await decryptBackup(backupPassword, envelope), target.key);
  assert.deepEqual(target.model.daily(first).habits, snapshots);
  assert.equal(target.model.journalList(target.key, first)[0].body, 'Existing encrypted entry');
});

test('weekday rest, weekly targets and optional completions keep historical expectations stable', t => {
  const f = fixture(t);
  const { model } = f;
  const base = model.habits()[0];
  model.saveHabit({ ...base, active: true, kind: 'weekdays', weekdays: 1 << 2 });
  model.saveHabit({ name: 'Swimming', description: '', minutes: 30, active: true, kind: 'weekly', target: 2 });
  const swimming = model.habits().find(item => item.name === 'Swimming');
  const tuesday = offset(first, 1);
  f.move(tuesday);
  assert.equal(model.daily(first).total, 4);
  assert.equal(model.daily(tuesday).total, 3);
  model.setCompletion(tuesday, base.id, true, tuesday);
  model.setCompletion(tuesday, swimming.id, true, tuesday);
  assert.equal(model.daily(tuesday).extraDone, 2);
  assert.equal(model.daily(tuesday).done, 0);
  assert.throws(() => model.setCompletion(offset(tuesday, 1), swimming.id, true, tuesday), /tracked date/);
  const wednesday = offset(first, 2);
  f.move(wednesday);
  assert.equal(model.daily(wednesday).total, 4);
  model.setCompletion(wednesday, swimming.id, true, wednesday);
  assert.deepEqual({ ...model.daily(wednesday).optional.find(item => item.habit === swimming.id).weekly },
    { goal: 2, completed: 2 });
  const oldWeek = model.weeklySummary(first, wednesday);
  assert.equal(oldWeek.completions, 3);
  assert.equal(oldWeek.habits.find(item => item.name === 'Swimming').weeklyCompleted, 2);
  assert.equal(oldWeek.habits.find(item => item.name === 'Swimming').target, 2);
  model.saveHabit({ ...swimming, active: true, kind: 'weekly', target: 4 });
  const next = offset(first, 7);
  f.move(next);
  assert.equal(model.weeklySummary(first, next).habits.find(item => item.name === 'Swimming').target, 2);
  assert.equal(model.weeklySummary(next, next).habits.find(item => item.name === 'Swimming').target, 4);
  assert.equal(model.daily(tuesday).total, 3);
  assert.equal(model.daily(tuesday).extraDone, 2);
});

test('schema 2 migration keeps monthly ciphertext and accepts version 2 encrypted backups', async t => {
  const source = fixture(t);
  const target = fixture(t);
  const month = first.slice(0, 7);
  const input = { version: 0, generation: source.model.meta('generation'),
    proud: 'Previous monthly reflection', learned: '', next: '', body: '' };
  source.model.migrateWriting(source.key);
  source.model.saveMonthlyReflection(source.key, month, input, month);
  const original = source.model.get('SELECT ciphertext FROM monthly_reflections').ciphertext;
  const prior = source.model.backup(source.key);
  prior.version = 2;
  delete prior.tables.weekly_reflections;
  source.model.db.exec('DROP TABLE habit_icons; DROP TABLE deleted_habits; DROP TABLE personal_notes; PRAGMA user_version=2');
  source.reopen();
  assert.equal(source.model.get('PRAGMA user_version').user_version, 6);
  assert.equal(source.model.get('SELECT ciphertext FROM monthly_reflections').ciphertext, original);
  const encrypted = await encryptBackup(backupPassword, prior);
  target.model.restore(await decryptBackup(backupPassword, encrypted), target.key);
  assert.match(target.model.monthlyReflection(target.key, month).body, /Previous monthly reflection/);
  assert.equal(target.model.get("SELECT count(*) AS n FROM sqlite_schema WHERE name='weekly_reflections'").n, 0);
});

test('guided, long-form and monthly conversions preserve all writing without duplicates or overwrites', t => {
  const f = fixture(t);
  const { model, key } = f;
  const next = offset(first, 1);
  f.move(next);
  const generation = model.meta('generation');
  const save = (id, day, fields) => model.saveJournal(key, id, { day, generation, version: 0, ...fields }, next);
  const quickId = quickReflectionId(first);
  save(quickId, first, { mode: 'free', title: 'Daily reflection', body: 'Existing quick reflection' });
  for (const day of [first, next]) save(guidedId(day), day, {
    mode: 'guided', accomplished: 'First answer', difficult: 'Second answer\n\nwith a paragraph', tomorrow: 'Third answer'
  });
  const long = save('e'.repeat(32), first, { mode: 'free', title: 'A title', body: 'A longer\n\nentry' });
  const month = first.slice(0, 7);
  model.saveMonthlyReflection(key, month, { generation, version: 0, proud: 'Proud answer', learned: 'Learned answer',
    next: 'Future answer', body: 'Existing free writing\n\nAnother paragraph' }, month);
  const original = model.get('SELECT ciphertext FROM journals WHERE id=?', quickId).ciphertext;
  const migrated = model.migrateWriting(key);
  assert.deepEqual(migrated, { notes: 1, daily: 1, guidedNotes: 1, monthly: 1 });
  assert.equal(model.get('SELECT ciphertext FROM journals WHERE id=?', quickId).ciphertext, original);
  assert.equal(model.get("SELECT count(*) AS n FROM journals WHERE mode='guided'").n, 2);
  const note = model.note(key, long.id);
  assert.deepEqual([note.title, note.body, note.event_day, note.created, note.modified], ['A title','A longer\n\nentry', first, long.created, long.modified]);
  const guided = model.notes(key, 1).entries.find(note => note.title === 'Legacy guided reflection');
  assert.match(model.note(key, guided.id).body, /First answer[\s\S]*Second answer\n\nwith a paragraph[\s\S]*Third answer/);
  assert.match(model.quickReflection(key, next, quickReflectionId(next)).body, /First answer[\s\S]*Third answer/);
  assert.match(model.monthlyReflection(key, month).body, /Proud answer[\s\S]*Learned answer[\s\S]*Future answer[\s\S]*Existing free writing\n\nAnother paragraph/);
  assert.deepEqual(model.migrateWriting(key), migrated);
  model.deleteNote(long.id, note.version, generation);
  const backup = model.backup(key);
  const destination = fixture(t);
  destination.model.restore(backup, destination.key);
  assert.equal(destination.model.note(destination.key, long.id), null);
  assert.equal(destination.model.notes(destination.key, 1).entries.length, 1);
});

test('nonempty live weekly tables block migration but old encrypted backups retain weekly writing as Notes', async t => {
  const f = fixture(t);
  const target = fixture(t);
  const week = first;
  const created = first + 'T06:00:00.000Z';
  const context = JSON.stringify(['steady/journal/v1', week, week, 'weekly', 1, created, created]);
  const ciphertext = seal(f.key, Buffer.from(JSON.stringify({ proud: 'A legacy week', learned: 'Challenges',
    next: 'Plans', body: 'An additional paragraph' })), context);
  const payload = f.model.backup(f.key);
  payload.version = 3;
  delete payload.tables.personal_notes;
  payload.tables.weekly_reflections = [{ week, ciphertext, created, modified: created, version: 1 }];
  const file = await encryptBackup(backupPassword, payload);
  target.model.restore(await decryptBackup(backupPassword, file), target.key);
  const [metadata] = target.model.notes(target.key, 1).entries;
  assert.equal(metadata.title, 'Legacy weekly reflection');
  assert.match(target.model.note(target.key, metadata.id).body, /A legacy week[\s\S]*Challenges[\s\S]*Plans[\s\S]*An additional paragraph/);
  f.model.db.exec('DROP TABLE habit_icons; DROP TABLE deleted_habits; DROP TABLE personal_notes; PRAGMA user_version=3');
  f.model.db.exec(readFileSync(new URL('../database/migrations/003.sql', import.meta.url), 'utf8'));
  f.model.run('INSERT INTO weekly_reflections VALUES (?,?,?,?,?)', week, ciphertext, created, created, 1);
  assert.throws(() => new SteadyModel(f.file), /Weekly reflection removal blocked/);
  assert.equal(f.model.get('SELECT ciphertext FROM weekly_reflections').ciphertext, ciphertext);
  assert.equal(f.model.get('PRAGMA user_version').user_version, 3);
});

