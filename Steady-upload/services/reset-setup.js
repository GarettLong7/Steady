import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SteadyModel } from '../models/steady.js';
import { offset, validDay } from './dates.js';

function requireEmptySetup(db) {
  const allowedMetadata = new Set(['credential','first','generation','passwordAttempts','sessionSecret','settings','writingMigration']);
  const keys = db.prepare('SELECT key FROM metadata').all();
  const first = db.prepare("SELECT json_extract(value,'$') AS day FROM metadata WHERE key='first'").get()?.day;
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  const expectedTables = ['challenges','completions','days','habits','journals','metadata','moods','sessions','snapshots'];
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const added = version >= 2 ? ['daily_plans','extra_completions','habit_schedules','monthly_reflections'] : [];
  if (version === 3) added.push('weekly_reflections');
  if (version >= 4) added.push('personal_notes');
  if (version >= 5) added.push('deleted_habits');
  if (version >= 6) added.push('habit_icons');
  if (![1,2,3,4,5,6].includes(version) ||
      JSON.stringify(tables) !== JSON.stringify([...expectedTables,...added].sort()) ||
      !keys.some(row => row.key === 'credential') || keys.some(row => !allowedMetadata.has(row.key)) ||
      !validDay(first) || ['completions','journals','moods',...added.filter(name => name !== 'daily_plans')]
        .some(name => db.prepare('SELECT 1 FROM ' + name + ' LIMIT 1').get())) {
    throw new Error('Reset refused. The database is not an empty initial setup.');
  }
  const defaults = new SteadyModel(':memory:', () => Date.parse(first + 'T12:00:00Z'));
  try {
    defaults.setup({});
    const same = sql => JSON.stringify(db.prepare(sql).all()) === JSON.stringify(defaults.all(sql));
    const days = db.prepare('SELECT day FROM days ORDER BY day').all();
    if (!same('SELECT * FROM habits ORDER BY id') ||
        !same('SELECT * FROM challenges ORDER BY id') ||
        !same("SELECT value FROM metadata WHERE key='settings'") ||
        days[0]?.day !== first ||
        (version >= 2 && db.prepare(`SELECT 1 FROM daily_plans p LEFT JOIN snapshots s USING(day,habit)
          WHERE s.habit IS NULL OR p.kind<>'daily' OR p.name<>s.name OR p.description<>s.description OR p.minutes<>s.minutes OR p.position<>s.position LIMIT 1`).get()) ||
        days.some(({ day }, index) => !validDay(day) || (index > 0 && day !== offset(days[index - 1].day, 1))) ||
        db.prepare(`
          SELECT 1 FROM days d CROSS JOIN habits h LEFT JOIN snapshots s ON s.day=d.day AND s.habit=h.id
          WHERE s.habit IS NULL OR s.name<>h.name OR s.description<>h.description OR s.minutes<>h.minutes OR s.position<>h.position
          LIMIT 1
        `).get() ||
        db.prepare('SELECT count(*) AS n FROM snapshots').get().n !== days.length * defaults.habits().length) {
      throw new Error('Reset refused. The database has custom habits, preferences, or tracking records.');
    }
  } finally {
    defaults.db.close();
  }
}

// Run while the app is stopped. SQLite backup includes committed WAL contents.
export async function resetEmptySetup(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  let backupPath;
  let version;
  try {
    requireEmptySetup(db);
    version = db.prepare('PRAGMA data_version').get().data_version;
    backupPath = join(mkdtempSync(join(dirname(filename), 'setup-backup-')), 'steady.sqlite');
    await backup(db, backupPath);
    const copy = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup integrity check failed.');
      requireEmptySetup(copy);
    } finally {
      copy.close();
    }

    const target = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
    try {
      target.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('PRAGMA data_version').get().data_version !== version) {
          throw new Error('The database changed during backup. Stop Steady before resetting.');
        }
        requireEmptySetup(target);
        if (target.prepare('PRAGMA user_version').get().user_version >= 2) target.exec('DELETE FROM daily_plans');
        target.exec('DELETE FROM sessions; DELETE FROM challenges; DELETE FROM snapshots; DELETE FROM days; DELETE FROM habits; DELETE FROM metadata;');
        target.exec('COMMIT');
      } catch (error) {
        target.exec('ROLLBACK');
        throw error;
      }
    } finally {
      target.close();
    }
    return backupPath;
  } finally {
    db.close();
  }
}

