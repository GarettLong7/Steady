import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { localDay, monthInfo, offset, percent, streaks, validDay, validMonth, validWeek, weekStart } from '../services/dates.js';
import { seal, unseal, token } from '../services/security.js';
import { dateQuery, writingPreview } from '../services/writing-search.js';
import { habitIconOptions } from '../services/habit-icons.js';

export const moods = ['Great', 'Good', 'Okay', 'Difficult'];
export const prompts = ['What did I accomplish today?', 'What was difficult today?', "What is one small thing I'll do tomorrow?"];
const defaults = [
  ['physical', 'Physical Health', 'Comfortable walking, gentle movement, or suitable physical activity.', 10],
  ['vietnamese', 'Vietnamese Practice', 'Vocabulary, pronunciation, listening, or conversation practice.', 5],
  ['skill', 'Skill Development', 'Coding, reading, learning, or career development.', 5],
  ['reflection', 'Daily Reflection', 'Journaling, reviewing the day, and preparing for tomorrow.', 5]
];
const tables = {
  habits: ['id','name','description','minutes','active','position','default_key'],
  days: ['day'],
  snapshots: ['day','habit','name','description','minutes','position'],
  completions: ['day','habit'],
  moods: ['day','mood'],
  journals: ['id','day','mode','ciphertext','created','modified','version'],
  challenges: ['id','started'],
  habit_schedules: ['habit','kind','weekdays','target'],
  daily_plans: ['day','habit','name','description','minutes','position','kind','target','scheduled'],
  extra_completions: ['day','habit'],
  monthly_reflections: ['month','ciphertext','created','modified','version'],
  personal_notes: ['id','event_day','ciphertext','created','modified','version'],
  deleted_habits: ['habit'],
  habit_icons: ['habit','icon']
};
const phase3 = ['habit_schedules','daily_plans','extra_completions','monthly_reflections'];
const optionalBackupTables = new Set(['deleted_habits', 'habit_icons']);
const schema = readFileSync(new URL('../database/migrations/001.sql', import.meta.url), 'utf8');
const migration2 = readFileSync(new URL('../database/migrations/002.sql', import.meta.url), 'utf8');
const migration3 = readFileSync(new URL('../database/migrations/003.sql', import.meta.url), 'utf8');
const migration4 = readFileSync(new URL('../database/migrations/004.sql', import.meta.url), 'utf8');
const migration5 = readFileSync(new URL('../database/migrations/005.sql', import.meta.url), 'utf8');
const migration6 = readFileSync(new URL('../database/migrations/006.sql', import.meta.url), 'utf8');
const backfillPlans = "INSERT INTO daily_plans SELECT day,habit,name,description,minutes,position,'daily',0,1 FROM snapshots";
export const monthlyPrompts = [
  'What am I proud of this month?', 'What did I learn about myself?', 'What would I like to do differently next month?', 'Free writing (optional)'
];
const weeklyPrompts = [
  'What went well this week?', 'What was challenging?', 'What would I like to focus on next week?', 'Free writing (optional)'
];
const periodFields = ['proud','learned','next','body'];
const periodContext = (row, mode) => {
  const key = mode === 'weekly' ? row.week : row.month;
  return { ...row, id: key, day: key, mode };
};
const noteContext = row => ({ ...row, day: row.event_day, mode: 'note' });
const stableId = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const quickReflectionId = day => stableId('steady/check-in/v1/' + day);
export const validNoteId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const meaningful = value => value.trim().length > 0;
const mergeWriting = (values, labels, keys) => keys.flatMap((field, i) =>
  meaningful(values[field]) ? [labels[i] ? labels[i] + '\n\n' + values[field] : values[field]] : []).join('\n\n');
const monthlyBody = content => {
  if (!periodFields.slice(0, 3).some(field => meaningful(content[field]))) return content.body;
  const answers = mergeWriting(content, monthlyPrompts, periodFields.slice(0, 3));
  return content.body.length ? answers + '\n\n' + monthlyPrompts[3] + '\n\n' + content.body : answers;
};
const singleMonthly = body => ({ proud: '', learned: '', next: '', body });

export function check(condition, message = 'Check the information you entered.', status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status, public: true });
}
export function settingsInput(input) {
  const { timezone, reminder } = input;
  const lock = Number(input.lock);
  check(typeof timezone === 'string' && timezone.length <= 100, 'Enter a valid IANA timezone.');
  try { localDay(new Date(), timezone); } catch { check(false, 'Enter a valid IANA timezone, such as Asia/Singapore.'); }
  check(Number.isInteger(lock) && lock >= 1 && lock <= 120, 'Choose a lock time between 1 and 120 minutes.');
  check(typeof reminder === 'string' && (reminder === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(reminder)), 'Enter a valid reminder time.');
  const settings = { timezone, lock, reminder };
  if (input.backupInterval !== undefined) {
    const interval = Number(input.backupInterval);
    check([0,7,14,30].includes(interval), 'Choose a backup reminder interval.');
    settings.backupInterval = interval;
  }
  return settings;
}
function journalContent(mode, source) {
  const fields = mode === 'monthly' || mode === 'weekly' ? periodFields : mode === 'guided' ? ['accomplished','difficult','tomorrow'] : ['title','body'];
  const value = {};
  for (const field of fields) {
    check(typeof source?.[field] === 'string' && source[field].length <= (field === 'title' ? 200 : field === 'body' ? 2100000 : 500000),
      field === 'title' ? 'Keep entry titles within 200 characters.' : 'This entry is too large to save.');
    value[field] = source[field];
  }
  return value;
}
function context(row) {
  return JSON.stringify(['steady/journal/v1', row.id, row.day, row.mode, row.version, row.created, row.modified]);
}
function readContent(row, key) {
  const bytes = unseal(key, row.ciphertext, context(row));
  try { return journalContent(row.mode, JSON.parse(bytes.toString())); }
  finally { bytes.fill(0); }
}
function writeContent(row, key, content) {
  const bytes = Buffer.from(JSON.stringify(content));
  try { return seal(key, bytes, context(row)); }
  finally { bytes.fill(0); }
}
export const guidedId = day => 'guided-' + day;

export class SteadyModel {
  constructor(filename, now = () => Date.now()) {
    this.now = now;
    this.db = new DatabaseSync(filename);
    this.db.function('steady_quick_id', { deterministic: true }, quickReflectionId);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    try {
      this.transaction(() => {
        const version = this.get('PRAGMA user_version').user_version;
        if (![0,1,2,3,4,5,6].includes(version)) throw new Error('Unsupported database version');
        if (version === 0) this.db.exec(schema);
        if (version < 2) this.db.exec(migration2 + '\nPRAGMA user_version=2;');
        if (version < 3) this.db.exec(migration3 + '\nPRAGMA user_version=3;');
        if (version < 4) {
          const savedWeeks = this.get('SELECT count(*) AS total FROM weekly_reflections').total;
          if (savedWeeks) throw new Error('Weekly reflection removal blocked. ' + savedWeeks + ' saved records require review.');
          this.db.exec(migration4 + '\nPRAGMA user_version=4;');
        }
        if (version < 5) this.db.exec(migration5 + '\nPRAGMA user_version=5;');
        if (version < 6) this.db.exec(migration6 + '\nPRAGMA user_version=6;');
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  meta(key) {
    const row = this.get('SELECT value FROM metadata WHERE key=?', key);
    return row ? JSON.parse(row.value) : null;
  }

  setMeta(key, value) {
    this.run('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }

  today() { return localDay(new Date(this.now()), this.meta('settings').timezone); }

  setup(credential) {
    this.transaction(() => {
      check(!this.meta('credential'), 'Steady has already been set up.', 409);
      this.setMeta('credential', credential);
      this.setMeta('settings', { timezone: 'Asia/Singapore', lock: 15, reminder: '' });
      this.setMeta('generation', token());
      const today = this.today();
      this.setMeta('first', today);
      this.restoreDefaults();
      this.recordDay(today);
      this.run('INSERT INTO challenges(started) VALUES (?)', today);
    });
  }

  recordDay(day) {
    this.run('INSERT INTO days VALUES (?)', day);
    this.recordHabitPlans(day);
  }

  recordHabitPlans(day, habit = null) {
    const weekdayMask = 1 << ((new Date(day).getUTCDay() + 6) % 7);
    this.run(`
      INSERT INTO daily_plans SELECT ?,id,name,description,minutes,position,coalesce(kind,'daily'),coalesce(target,0),
        CASE WHEN kind IS NULL OR (kind='weekdays' AND (weekdays & ?)<>0) THEN 1 ELSE 0 END
      FROM habits LEFT JOIN habit_schedules s ON s.habit=habits.id
      WHERE active=1 AND (? IS NULL OR habits.id=?)
    `, day, weekdayMask, habit, habit);
    this.run(`INSERT INTO snapshots SELECT day,habit,name,description,minutes,position
      FROM daily_plans WHERE day=? AND scheduled=1 AND (? IS NULL OR habit=?)`, day, habit, habit);
  }

  materializeThrough(today) {
    const latest = this.get('SELECT max(day) AS day FROM days').day;
    if (latest === today) {
      this.ensureFirstHabitPlans(today);
      this.ensureWeeklyPlans(today);
    }
    if (latest && latest >= today) return;
    const first = latest ? offset(latest, 1) : this.meta('first');
    if (first > today) return;
    this.transaction(() => {
      const last = this.get('SELECT max(day) AS day FROM days').day;
      for (let day = last ? offset(last, 1) : first; day <= today; day = offset(day, 1)) this.recordDay(day);
    });
  }

  ensureFirstHabitPlans(today) {
    // Earlier versions could save a custom habit without its first daily plan.
    const missing = `SELECT h.id FROM habits h WHERE h.active=1 AND h.default_key=''
      AND NOT EXISTS (SELECT 1 FROM daily_plans p WHERE p.habit=h.id)`;
    if (!this.get(missing + ' LIMIT 1')) return;
    this.transaction(() => {
      for (const { id } of this.all(missing)) this.recordHabitPlans(today, id);
    });
  }

  ensureWeeklyPlans(today) {
    // A new optional goal can start today without changing any scheduled plan.
    const missing = `
      FROM habits h JOIN habit_schedules s ON s.habit=h.id
      WHERE h.active=1 AND s.kind='weekly' AND
        NOT EXISTS (SELECT 1 FROM daily_plans p WHERE p.day=? AND p.habit=h.id)
    `;
    if (!this.get('SELECT 1 ' + missing + ' LIMIT 1', today)) return;
    this.run(`INSERT INTO daily_plans
      SELECT ?,h.id,h.name,h.description,h.minutes,h.position,'weekly',s.target,0 ${missing}
      AND ?=(SELECT max(day) FROM days) ON CONFLICT(day,habit) DO NOTHING`, today, today, today);
  }

  requireDay(day, today) {
    check(validDay(day) && day <= today && !!this.get('SELECT 1 FROM days WHERE day=?', day),
      'Choose a tracked date up to today.');
  }

  habits() { return this.all('SELECT * FROM habits ORDER BY position,id'); }
  manageableHabits() {
    return this.all('SELECT * FROM habits WHERE id NOT IN (SELECT habit FROM deleted_habits) ORDER BY position,id');
  }
  habitSettings() {
    return this.all(`SELECT habits.*,coalesce(kind,'daily') AS kind,coalesce(weekdays,0) AS weekdays,
      coalesce(target,0) AS target,coalesce(icon,nullif(default_key,''),'plus') AS icon
      FROM habits LEFT JOIN habit_schedules s ON s.habit=habits.id LEFT JOIN habit_icons i ON i.habit=habits.id
      WHERE habits.id NOT IN (SELECT habit FROM deleted_habits) ORDER BY position,id`);
  }

  dashboardHabitIcons(showOverrides) {
    const rows = this.all(`SELECT h.id, CASE WHEN ? AND s.kind IS NULL THEN coalesce(i.icon,h.default_key)
      ELSE h.default_key END AS icon FROM habits h
      LEFT JOIN habit_icons i ON i.habit=h.id LEFT JOIN habit_schedules s ON s.habit=h.id`, Number(showOverrides));
    return Object.fromEntries(rows.map(({ id, icon }) => [id, icon]));
  }

  saveHabit(input, today = this.today()) {
    const { id, description, active, icon } = input;
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const minutes = Number(input.minutes);
    check(name.length >= 1 && name.length <= 100 && typeof description === 'string' && description.length <= 500 &&
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 && typeof active === 'boolean',
    'Enter a name, a description up to 500 characters, and a duration of 1–1440 minutes.');
    check(id === undefined || Number.isSafeInteger(id), 'Habit not found.', 404);
    const previous = id === undefined ? null : this.get('SELECT kind,weekdays,target FROM habit_schedules WHERE habit=?', id);
    const kind = input.kind ?? previous?.kind ?? 'daily';
    check(icon === undefined || (kind === 'daily' && typeof icon === 'string' && Object.hasOwn(habitIconOptions, icon)),
      'Choose a supported icon for a daily habit.');
    const weekdays = kind === 'weekdays' ? Number(input.weekdays ?? previous?.weekdays) : 0;
    const target = kind === 'weekly' ? Number(input.target ?? previous?.target) : 0;
    check(['daily','weekdays','weekly'].includes(kind) &&
      (kind !== 'weekdays' || Number.isInteger(weekdays) && weekdays >= 1 && weekdays <= 127) &&
      (kind !== 'weekly' || Number.isInteger(target) && target >= 1 && target <= 7), 'Choose weekdays or a weekly target from 1 to 7 days.');
    return this.transaction(() => {
      let habit = id;
      if (id === undefined) {
        habit = this.run('INSERT INTO habits(name,description,minutes,active,position) VALUES (?,?,?,?,(SELECT coalesce(max(position)+1,0) FROM habits))',
          name, description, minutes, Number(active)).lastInsertRowid;
      } else {
        check(this.get('SELECT 1 FROM habits WHERE id=? AND id NOT IN (SELECT habit FROM deleted_habits)', id), 'Habit not found.', 404);
        this.run('UPDATE habits SET name=?,description=?,minutes=?,active=? WHERE id=?', name, description, minutes, Number(active), id);
      }
      if (kind === 'daily') this.run('DELETE FROM habit_schedules WHERE habit=?', habit);
      else this.run('INSERT INTO habit_schedules VALUES (?,?,?,?) ON CONFLICT(habit) DO UPDATE SET kind=excluded.kind,weekdays=excluded.weekdays,target=excluded.target',
        habit, kind, weekdays, target);
      if (icon !== undefined) this.run('INSERT INTO habit_icons VALUES (?,?) ON CONFLICT(habit) DO UPDATE SET icon=excluded.icon', habit, icon);
      if (active && id === undefined && this.get('SELECT 1 FROM days WHERE day=?', today)) {
        // Add only the new habit to today's plan so existing snapshots and check-offs survive.
        this.recordHabitPlans(today, habit);
      } else if (active && kind === 'weekly') {
        this.ensureWeeklyPlans(today);
      }
    });
  }

  deleteHabit(id, today) {
    check(Number.isSafeInteger(id), 'Habit not found.', 404);
    this.transaction(() => {
      check(this.run('UPDATE habits SET active=0 WHERE id=?', id).changes, 'Habit not found.', 404);
      if (!this.run('INSERT INTO deleted_habits VALUES (?) ON CONFLICT DO NOTHING', id).changes) return;
      const completed = this.get('SELECT 1 FROM completions WHERE day=? AND habit=? UNION ALL SELECT 1 FROM extra_completions WHERE day=? AND habit=?',
        today, id, today, id);
      if (!completed) {
        this.run('DELETE FROM snapshots WHERE day=? AND habit=?', today, id);
        this.run('DELETE FROM daily_plans WHERE day=? AND habit=?', today, id);
      }
    });
  }

  restoreDefaults() {
    this.run("DELETE FROM deleted_habits WHERE habit IN (SELECT id FROM habits WHERE default_key<>'')");
    this.run("DELETE FROM habit_schedules WHERE habit IN (SELECT id FROM habits WHERE default_key<>'')");
    let position = this.get('SELECT coalesce(max(position)+1,0) AS next FROM habits').next;
    this.run('UPDATE habits SET active=0');
    for (const [key, name, description, minutes] of defaults) {
      const existing = this.get('SELECT id FROM habits WHERE default_key=?', key);
      if (existing) this.run('UPDATE habits SET name=?,description=?,minutes=?,active=1,position=? WHERE id=?', name, description, minutes, position++, existing.id);
      else this.run('INSERT INTO habits(name,description,minutes,active,position,default_key) VALUES (?,?,?,1,?,?)', name, description, minutes, position++, key);
    }
  }

  reorder(id, direction) {
    check(direction === 'up' || direction === 'down', 'Choose a reorder direction.');
    const habits = this.manageableHabits();
    const index = habits.findIndex(habit => habit.id === id);
    check(index >= 0, 'Habit not found.', 404);
    const other = habits[index + (direction === 'up' ? -1 : 1)];
    if (other) this.transaction(() => {
      this.run('UPDATE habits SET position=? WHERE id=?', other.position, id);
      this.run('UPDATE habits SET position=? WHERE id=?', habits[index].position, other.id);
    });
  }

  summaries(from, through) {
    return this.all(`
      SELECT days.day, count(s.habit) AS total, count(c.habit) AS done FROM days
      LEFT JOIN snapshots s USING(day) LEFT JOIN completions c ON c.day=s.day AND c.habit=s.habit
      WHERE days.day BETWEEN ? AND ? GROUP BY days.day ORDER BY days.day
    `, from, through).map(row => ({ ...row, full: row.total > 0 && row.total === row.done,
      percentage: percent(row.done, row.total) }));
  }

  daily(day) {
    const habits = this.all(`
      SELECT s.*, c.habit IS NOT NULL AS completed FROM snapshots s LEFT JOIN completions c USING(day,habit)
      WHERE day=? ORDER BY position,habit
    `, day);
    const done = habits.filter(habit => habit.completed).length;
    const optional = this.all(`
      SELECT p.*, c.habit IS NOT NULL AS completed FROM daily_plans p LEFT JOIN extra_completions c USING(day,habit)
      WHERE p.day=? AND p.scheduled=0 ORDER BY p.position,p.habit
    `, day);
    for (const habit of optional) {
      if (habit.kind !== 'weekly') continue;
      const start = weekStart(day);
      const progress = this.get(`
        SELECT (SELECT target FROM daily_plans WHERE habit=? AND kind='weekly' AND day BETWEEN ? AND ? ORDER BY day LIMIT 1) AS goal,
          count(e.habit) AS completed
        FROM daily_plans p LEFT JOIN extra_completions e USING(day,habit)
        WHERE p.habit=? AND p.kind='weekly' AND p.day BETWEEN ? AND ?
      `, habit.habit, start, day, habit.habit, start, day);
      habit.weekly = progress;
    }
    return { day, habits, done, total: habits.length, percentage: percent(done, habits.length),
      optional, extraDone: optional.filter(habit => habit.completed).length,
      mood: this.get('SELECT mood FROM moods WHERE day=?', day)?.mood ?? '' };
  }

  setCompletion(day, habit, completed, today) {
    this.requireDay(day, today);
    check(Number.isSafeInteger(habit) && typeof completed === 'boolean', 'Invalid habit update.');
    const plan = this.get('SELECT scheduled FROM daily_plans WHERE day=? AND habit=?', day, habit);
    check(plan, 'This habit was not available on that date.', 404);
    const table = plan.scheduled ? 'completions' : 'extra_completions';
    if (completed) this.run('INSERT INTO ' + table + ' VALUES (?,?) ON CONFLICT DO NOTHING', day, habit);
    else this.run('DELETE FROM ' + table + ' WHERE day=? AND habit=?', day, habit);
    return this.daily(day);
  }

  setMood(day, mood, today) {
    this.requireDay(day, today);
    check(mood === '' || moods.includes(mood), 'Choose a listed mood.');
    if (mood) this.run('INSERT INTO moods VALUES (?,?) ON CONFLICT(day) DO UPDATE SET mood=excluded.mood', day, mood);
    else this.run('DELETE FROM moods WHERE day=?', day);
  }

  calendar(month, today) {
    const info = monthInfo(month);
    const from = info.dates[0];
    const through = today < info.dates.at(-1) ? today : info.dates.at(-1);
    const rows = new Map(this.summaries(from, through)
      .map(row => [row.day, row]));
    const activity = new Map(this.all(`
      SELECT day, (EXISTS(SELECT 1 FROM journals WHERE id=steady_quick_id(days.day))
        OR EXISTS(SELECT 1 FROM personal_notes WHERE coalesce(nullif(event_day,''),date(created,'+8 hours'))=days.day)) AS journal,
        EXISTS(SELECT 1 FROM moods WHERE moods.day=days.day) AS mood,
        EXISTS(SELECT 1 FROM extra_completions WHERE extra_completions.day=days.day) AS extra
      FROM days WHERE day BETWEEN ? AND ?
    `, from, through).map(row => [row.day, row]));
    return { ...info, cells: info.dates.map(day => {
      const data = rows.get(day);
      const { journal = 0, mood = 0, extra = 0 } = activity.get(day) ?? {};
      const state = day > today ? 'future' : !data?.total ? (extra ? 'optional-activity' : 'unscheduled') : data.full ? 'full' :
        data.done ? 'partial' : journal || mood || extra ? 'incomplete' : 'unrecorded';
      return { day, state, data, journal: Boolean(journal), mood: Boolean(mood), extra: Boolean(extra) };
    }) };
  }

  weeklySummary(start, today) {
    const end = offset(start, 6);
    const through = end < today ? end : today;
    const rows = new Map(this.summaries(start, through).map(row => [row.day, row]));
    const moodRows = this.all('SELECT day,mood FROM moods WHERE day BETWEEN ? AND ?', start, through);
    const extraRows = this.all('SELECT day,count(*) AS total FROM extra_completions WHERE day BETWEEN ? AND ? GROUP BY day', start, through);
    const extraByDay = new Map(extraRows.map(row => [row.day, row.total]));
    const dayMoods = new Map(moodRows.map(row => [row.day, row.mood]));
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = offset(start, index);
      const row = rows.get(day);
      const done = (row?.done ?? 0) + (extraByDay.get(day) ?? 0);
      const recorded = Boolean(done || dayMoods.has(day));
      return { day, recorded, upcoming: day > today, done,
        percentage: recorded && row?.total ? row.percentage : null };
    });
    const habits = new Map();
    for (const row of this.all(`
      SELECT p.habit,p.name,p.kind,p.target,p.scheduled,c.habit IS NOT NULL AS completed,
        e.habit IS NOT NULL AS extra FROM daily_plans p
      LEFT JOIN completions c USING(day,habit) LEFT JOIN extra_completions e USING(day,habit)
      WHERE p.day BETWEEN ? AND ? ORDER BY p.day,p.position,p.habit
    `, start, through)) {
      const summary = habits.get(row.habit) ?? { scheduled: 0, completed: 0, extra: 0, target: 0, weeklyCompleted: 0 };
      summary.name = row.name;
      summary.scheduled += row.scheduled;
      summary.completed += row.completed;
      if (row.kind === 'weekly') {
        summary.target ||= row.target;
        summary.weeklyCompleted += row.extra;
      } else summary.extra += row.extra;
      habits.set(row.habit, summary);
    }
    const recordedDays = days.filter(row => row.recorded).length;
    const completions = days.reduce((total, row) => total + row.done, 0);
    const previous = offset(start, -7);
    const previousThrough = offset(through, -7);
    const previousRows = this.summaries(previous, previousThrough);
    const previousCompletions = previousRows.reduce((total, row) => total + row.done, 0) +
      this.get('SELECT count(*) AS n FROM extra_completions WHERE day BETWEEN ? AND ?', previous, previousThrough).n;
    const previousActive = previousCompletions > 0 ||
      Boolean(this.get('SELECT 1 FROM moods WHERE day BETWEEN ? AND ? LIMIT 1', previous, previousThrough));
    return {
      start, end, days, recordedDays, completions, habits: [...habits.values()],
      moods: moods.map(mood => ({ mood, count: moodRows.filter(row => row.mood === mood).length })),
      comparison: recordedDays && previousActive ? { previousCompletions, partial: through !== end } : null
    };
  }

  statistics(today) {
    const rows = this.summaries(this.meta('first'), today);
    const fullDays = rows.filter(row => row.full).length;
    const rate = days => {
      const scheduled = rows.filter(row => row.day >= offset(today, -(days - 1)) && row.total > 0);
      return scheduled.length ? percent(scheduled.filter(row => row.full).length, scheduled.length) : null;
    };
    const perHabit = new Map();
    for (const row of this.all(`
      SELECT s.day,s.habit,c.habit IS NOT NULL AS full FROM snapshots s
      LEFT JOIN completions c USING(day,habit) WHERE s.day<=? ORDER BY s.day
    `, today)) {
      if (!perHabit.has(row.habit)) perHabit.set(row.habit, []);
      perHabit.get(row.habit).push(row);
    }
    const habits = this.habits().map(habit => {
      const scheduled = perHabit.get(habit.id) ?? [];
      const completed = scheduled.filter(row => row.full).length;
      const series = [];
      const hasUnplannedGap = (from, until) => {
        if (from >= until) return false;
        const count = this.get('SELECT count(*) AS n FROM daily_plans WHERE habit=? AND scheduled=0 AND day>=? AND day<?',
          habit.id, from, until).n;
        return count < (Date.parse(until) - Date.parse(from)) / 86400000;
      };
      for (const row of scheduled) {
        if (series.length && hasUnplannedGap(offset(series.at(-1).day, 1), row.day)) {
          series.push({ day: offset(row.day, -1), full: false });
        }
        series.push(row);
      }
      if (series.length && hasUnplannedGap(offset(series.at(-1).day, 1), today)) {
        series.push({ day: offset(today, -1), full: false });
      }
      return { ...habit, completed, percentage: scheduled.length ? percent(completed, scheduled.length) : null, ...streaks(series, today) };
    });
    const active = this.get('SELECT started FROM challenges WHERE started<=? ORDER BY id DESC LIMIT 1', today);
    const end = active ? offset(active.started, 13) : null;
    const challenge = active ? { started: active.started, end, goal: 11,
      completed: rows.filter(row => row.day >= active.started && row.day <= end && row.full).length } : null;
    const byDate = new Map(rows.map(row => [row.day, row]));
    const planned = new Set(this.all('SELECT DISTINCT day FROM daily_plans WHERE scheduled=0 AND day<=?', today).map(row => row.day));
    return { tracked: rows.filter(row => row.total > 0).length, fullDays, ...streaks(rows.filter(row => row.total || !planned.has(row.day)), today),
      weekRate: rate(7), monthRate: rate(30), habits, challenge,
      week: Array.from({ length: 7 }, (_, i) => {
        const day = offset(today, i - 6);
        return byDate.get(day) ?? { day, percentage: 0, total: 0 };
      }) };
  }

  journalList(key, day, query = '', through = '9999-12-31') {
    const rows = day
      ? this.all('SELECT * FROM journals WHERE day=? AND day<=? ORDER BY created DESC,id DESC', day, through)
      : this.all('SELECT * FROM journals WHERE day<=? ORDER BY day DESC,created DESC,id DESC', through);
    const term = query.trim().toLocaleLowerCase();
    const results = [];
    for (const row of rows) {
      const content = readContent(row, key);
      if (term && !Object.values(content).some(value => value.toLocaleLowerCase().includes(term))) continue;
      const { ciphertext, ...metadata } = row;
      results.push({ ...metadata, ...content });
    }
    return results;
  }

  quickReflection(key, day, id) {
    const row = this.get("SELECT * FROM journals WHERE id=? AND day=? AND mode='free'", id, day);
    return row ? { id, version: row.version, ...readContent(row, key) } :
      { id, version: 0, title: 'Daily reflection', body: '' };
  }

  saveJournal(key, id, input, today) {
    this.requireDay(input.day, today);
    const { day, mode, version } = input;
    check(mode === 'guided' ? id === guidedId(day) : mode === 'free' && /^[a-f0-9]{32}$/.test(id), 'Invalid journal entry.');
    check(Number.isSafeInteger(version) && version >= 0, 'Invalid journal revision.');
    const content = journalContent(mode, input);
    return this.transaction(() => {
      const row = this.get('SELECT * FROM journals WHERE id=?', id);
      if (input.generation === this.meta('generation') && row?.version === version + 1 &&
          row.day === day && row.mode === mode &&
          JSON.stringify(readContent(row, key)) === JSON.stringify(content)) {
        const { ciphertext, ...saved } = row;
        return saved;
      }
      check(input.generation === this.meta('generation') && (row?.version ?? 0) === version &&
        (!row || (row.day === day && row.mode === mode)),
      'This entry changed elsewhere. Your text is still here. Copy it before reopening the latest entry.', 409);
      const modified = new Date(this.now()).toISOString();
      const updated = { id, day, mode, created: row?.created ?? modified, modified, version: version + 1 };
      const ciphertext = writeContent(updated, key, content);
      if (row) this.run('UPDATE journals SET ciphertext=?,modified=?,version=? WHERE id=?', ciphertext, modified, updated.version, id);
      else this.run('INSERT INTO journals VALUES (?,?,?,?,?,?,?)', id, day, mode, ciphertext, updated.created, modified, updated.version);
      return updated;
    });
  }

  deleteJournal(id, version, generation, today) {
    const row = this.get('SELECT day,version FROM journals WHERE id=?', id);
    check(row && row.day <= today, 'Journal entry not found.', 404);
    check(version === row.version && generation === this.meta('generation'), 'This entry has changed. Reopen it before deleting.', 409);
    this.run('DELETE FROM journals WHERE id=?', id);
    // Invalidate old drafts even if a guided entry is later recreated with the same ID.
    this.setMeta('generation', token());
  }

  monthlyReflection(key, month) {
    const row = this.get('SELECT * FROM monthly_reflections WHERE month=?', month);
    return row ? { version: row.version, ...readContent(periodContext(row, 'monthly'), key) } : { version: 0 };
  }

  migrateWriting(key) {
    const counts = this.meta('writingMigration');
    return counts ?? this.transaction(() => this.meta('writingMigration') ?? this.convertWriting(key));
  }

  convertWriting(key) {
    const counts = { notes: 0, daily: 0, guidedNotes: 0, monthly: 0 };
    const legacy = this.all("SELECT * FROM journals WHERE mode='guided' OR id<>steady_quick_id(day) ORDER BY day,id");
    for (const row of legacy) {
      const content = readContent(row, key);
      const guided = row.mode === 'guided';
      const body = guided ? mergeWriting(content, prompts, ['accomplished','difficult','tomorrow']) : content.body;
      const id = quickReflectionId(row.day);
      if (guided && !this.get('SELECT 1 FROM journals WHERE id=?', id)) {
        const daily = { ...row, id, mode: 'free', version: 1 };
        const value = { title: 'Daily reflection', body };
        const ciphertext = writeContent(daily, key, value);
        this.run('INSERT INTO journals VALUES (?,?,?,?,?,?,?)', id, row.day, 'free', ciphertext, row.created, row.modified, 1);
        check(readContent(this.get('SELECT * FROM journals WHERE id=?', id), key).body === body, 'Daily writing conversion could not be verified.');
        counts.daily++;
      } else {
        this.insertPreservedNote(key, { id: guided ? stableId('steady/legacy-guided/' + row.id) : row.id,
          event_day: row.day, created: row.created, modified: row.modified, version: 1 },
        { title: guided ? 'Legacy guided reflection' : content.title, body });
        counts[guided ? 'guidedNotes' : 'notes']++;
      }
    }
    for (const row of this.all('SELECT * FROM monthly_reflections')) {
      const content = readContent(periodContext(row, 'monthly'), key);
      if (!periodFields.slice(0, 3).some(field => meaningful(content[field]))) continue;
      const body = monthlyBody(content);
      const updated = { ...row, version: row.version + 1 };
      this.run('UPDATE monthly_reflections SET ciphertext=?,version=? WHERE month=?',
        writeContent(periodContext(updated, 'monthly'), key, singleMonthly(body)), updated.version, row.month);
      const saved = this.get('SELECT * FROM monthly_reflections WHERE month=?', row.month);
      check(readContent(periodContext(saved, 'monthly'), key).body === body, 'Monthly writing conversion could not be verified.');
      counts.monthly++;
    }
    this.setMeta('writingMigration', counts);
    return counts;
  }

  insertPreservedNote(key, row, value) {
    const ciphertext = writeContent(noteContext(row), key, value);
    this.run('INSERT INTO personal_notes VALUES (?,?,?,?,?,?)', row.id, row.event_day, ciphertext, row.created, row.modified, row.version);
    const saved = this.get('SELECT * FROM personal_notes WHERE id=?', row.id);
    check(JSON.stringify(readContent(noteContext(saved), key)) === JSON.stringify(value), 'Note conversion could not be verified.');
  }

  note(key, id) {
    const row = this.get('SELECT * FROM personal_notes WHERE id=?', id);
    if (!row) return null;
    const { ciphertext, ...metadata } = row;
    return { ...metadata, ...readContent(noteContext(row), key) };
  }

  notes(key, page) {
    const rows = this.all('SELECT * FROM personal_notes ORDER BY modified DESC,id LIMIT 51 OFFSET ?', (page - 1) * 50);
    const entries = rows.slice(0, 50).map(row => {
      const content = readContent(noteContext(row), key);
      return { id: row.id, title: content.title, preview: writingPreview(content.body),
        date: row.event_day || localDay(new Date(row.created), 'Asia/Singapore'),
        edited: localDay(new Date(row.modified), 'Asia/Singapore') };
    });
    return { entries, next: rows.length > 50 };
  }

  saveNote(key, id, input) {
    const { eventDay, generation, version } = input;
    check(validNoteId(id) && (eventDay === '' || validDay(eventDay)) && Number.isSafeInteger(version) && version >= 0,
      'Choose a valid optional event date.');
    const content = journalContent('note', input);
    return this.transaction(() => {
      const row = this.get('SELECT * FROM personal_notes WHERE id=?', id);
      const current = generation === this.meta('generation');
      if (current && row?.version === version + 1 && row.event_day === eventDay &&
          JSON.stringify(readContent(noteContext(row), key)) === JSON.stringify(content)) return { version: row.version };
      check(current && (row?.version ?? 0) === version, 'This note changed elsewhere. Copy your unsaved text before reopening.', 409);
      const modified = new Date(this.now()).toISOString();
      const updated = { id, event_day: eventDay, created: row?.created ?? modified, modified, version: version + 1 };
      const ciphertext = writeContent(noteContext(updated), key, content);
      this.run(`
        INSERT INTO personal_notes VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE
        SET event_day=excluded.event_day,ciphertext=excluded.ciphertext,modified=excluded.modified,version=excluded.version
      `, id, eventDay, ciphertext, updated.created, modified, updated.version);
      return { version: updated.version };
    });
  }

  deleteNote(id, version, generation) {
    this.transaction(() => {
      const row = this.get('SELECT version FROM personal_notes WHERE id=?', id);
      check(row, 'Note not found.', 404);
      check(generation === this.meta('generation') && row.version === version, 'This note changed elsewhere. Reopen it before deleting.', 409);
      this.run('DELETE FROM personal_notes WHERE id=?', id);
      this.setMeta('generation', token());
    });
  }

  writingRows(today, type = '') {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT 'daily' AS type,id,day AS date,day AS event_day,ciphertext,created,modified,version
        FROM journals WHERE mode='free' AND id=steady_quick_id(day) AND day<=?
        UNION ALL
        SELECT 'monthly',month,month,month,ciphertext,created,modified,version FROM monthly_reflections WHERE month<=?
        UNION ALL
        SELECT 'note',id,coalesce(nullif(event_day,''),date(created,'+8 hours')),event_day,ciphertext,created,modified,version
        FROM personal_notes
      ) WHERE (?='' OR type=?) ORDER BY date DESC,modified DESC,id
    `).iterate(today, today.slice(0, 7), type, type);
  }

  writingContent(key, row) {
    if (row.type === 'note') return readContent(noteContext(row), key);
    if (row.type === 'monthly') {
      return { title: '', body: monthlyBody(readContent(periodContext({ ...row, month: row.date }, 'monthly'), key)) };
    }
    return readContent({ ...row, day: row.date, mode: 'free' }, key);
  }

  searchWriting(key, query, day, type, today) {
    const phrase = query.trim();
    const daily = type === 'daily';
    const matchesDate = daily ? null : dateQuery(phrase.toLowerCase().replace(/\s+/g, ' '));
    const keyword = phrase && !matchesDate ? new RegExp(RegExp.escape(phrase), 'iu') : null;
    const entries = [];
    let scanned = 0;
    for (const row of this.writingRows(today, type)) {
      if (day && row.date !== (row.type === 'monthly' ? day.slice(0, 7) : day)) continue;
      if (matchesDate && !matchesDate(row.date)) continue;
      if (!daily && ++scanned > 3000) return { entries, limited: true };
      const { title, body } = this.writingContent(key, row);
      const match = keyword?.exec(body);
      if (keyword && !match && (daily || !keyword.test(title))) continue;
      if (entries.length === 75) return { entries, limited: true };
      const href = row.type === 'daily' ? '/?day=' + row.date : row.type === 'monthly' ?
        '/monthly?month=' + row.date : '/notes/' + row.id;
      entries.push({ kind: row.type, date: row.date, title: row.type === 'note' ? title : '', preview: writingPreview(body, match), href });
    }
    return { entries, limited: false };
  }

  saveMonthlyReflection(key, month, input, latest) {
    check(validMonth(month) && month <= latest, 'Choose a month through this month.');
    const { version, generation } = input;
    check(Number.isSafeInteger(version) && version >= 0, 'Invalid reflection revision.');
    const content = journalContent('monthly', input);
    return this.transaction(() => {
      const row = this.get('SELECT * FROM monthly_reflections WHERE month=?', month);
      const current = generation === this.meta('generation');
      if (current && row?.version === version + 1 &&
          JSON.stringify(readContent(periodContext(row, 'monthly'), key)) === JSON.stringify(content)) return { version: row.version };
      check(current && (row?.version ?? 0) === version,
        'This reflection changed elsewhere. Copy your unsaved text before reopening.', 409);
      const modified = new Date(this.now()).toISOString();
      const updated = { month, created: row?.created ?? modified, modified, version: version + 1 };
      const ciphertext = writeContent(periodContext(updated, 'monthly'), key, content);
      this.run(`
        INSERT INTO monthly_reflections VALUES (?,?,?,?,?) ON CONFLICT(month) DO UPDATE
        SET ciphertext=excluded.ciphertext,modified=excluded.modified,version=excluded.version
      `, month, ciphertext, updated.created, modified, updated.version);
      return { version: updated.version };
    });
  }

  backup(key) {
    this.migrateWriting(key);
    return { version: 4, settings: this.meta('settings'), first: this.meta('first'), dek: key.toString('hex'),
      tables: Object.fromEntries(Object.keys(tables).map(name => [name, this.all('SELECT * FROM ' + name)])) };
  }

  restore(data, targetKey) {
    check([1,2,3,4].includes(data?.version) && validDay(data.first) && typeof data.dek === 'string' &&
      /^[a-f0-9]{64}$/.test(data.dek), 'Invalid backup structure.');
    const settings = settingsInput(data.settings ?? {});
    const sourceKey = Buffer.from(data.dek, 'hex');
    try {
      this.transaction(() => {
        for (const name of Object.keys(tables).reverse()) this.run('DELETE FROM ' + name);
        for (const [name, columns] of Object.entries(tables)) {
          if (data.version === 1 && phase3.includes(name)) continue;
          if (data.version < 4 && name === 'personal_notes') continue;
          const saved = data.tables?.[name];
          const rows = saved === undefined && optionalBackupTables.has(name) ? [] : saved;
          check(Array.isArray(rows), 'Invalid backup structure.');
          const insert = this.db.prepare('INSERT INTO ' + name + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
          for (const item of rows) {
            const row = item && { ...item };
            check(row && typeof row === 'object' && Object.keys(row).length === columns.length &&
              columns.every(column => typeof row[column] === 'string' || Number.isSafeInteger(row[column])),
              'Invalid backup records.');
            if ('day' in row) check(validDay(row.day) && row.day >= data.first, 'Invalid backup dates.');
            if (name === 'journals') {
              check((row.mode === 'guided' ? row.id === guidedId(row.day) : row.mode === 'free' && /^[a-f0-9]{32}$/.test(row.id)) &&
                [row.created, row.modified].every(time => Number.isFinite(Date.parse(time))), 'Invalid journal records.');
              row.ciphertext = writeContent(row, targetKey, readContent(row, sourceKey));
            }
            if (name === 'monthly_reflections' || name === 'personal_notes') {
              const note = name === 'personal_notes';
              check((note ? validNoteId(row.id) && (row.event_day === '' || validDay(row.event_day)) : validMonth(row.month)) &&
                [row.created, row.modified].every(time => Number.isFinite(Date.parse(time))), 'Invalid writing records.');
              const record = note ? noteContext(row) : periodContext(row, 'monthly');
              row.ciphertext = writeContent(record, targetKey, readContent(record, sourceKey));
            }
            insert.run(...columns.map(column => row[column]));
          }
        }
        this.run('UPDATE habits SET active=0 WHERE id IN (SELECT habit FROM deleted_habits)');
        if (data.version === 1) this.run(backfillPlans);
        if (data.version < 4) {
          const counts = this.convertWriting(targetKey);
          const weeks = data.tables?.weekly_reflections ?? [];
          check(Array.isArray(weeks), 'Invalid legacy weekly reflections.');
          for (const row of weeks) {
            check(validWeek(row?.week) && typeof row.ciphertext === 'string' && Number.isSafeInteger(row.version) && row.version > 0 &&
              [row.created, row.modified].every(time => typeof time === 'string' && Number.isFinite(Date.parse(time))), 'Invalid legacy weekly reflection.');
            const content = readContent(periodContext(row, 'weekly'), sourceKey);
            this.insertPreservedNote(targetKey, { id: stableId('steady/legacy-week/' + row.week),
              event_day: row.week, created: row.created, modified: row.modified, version: 1 },
            { title: 'Legacy weekly reflection', body: mergeWriting(content, weeklyPrompts, periodFields) });
          }
          this.setMeta('writingMigration', { ...counts, weeklyNotes: weeks.length });
        } else {
          this.setMeta('writingMigration', { restored: true });
        }
        check(!this.get(`
          SELECT 1 FROM snapshots s LEFT JOIN daily_plans p USING(day,habit)
          WHERE p.scheduled IS NOT 1 OR p.name<>s.name OR p.description<>s.description OR p.minutes<>s.minutes OR p.position<>s.position
          UNION ALL
          SELECT 1 FROM daily_plans p LEFT JOIN snapshots s USING(day,habit)
          WHERE p.scheduled=1 AND s.habit IS NULL
          UNION ALL
          SELECT 1 FROM extra_completions e JOIN daily_plans p USING(day,habit) WHERE p.scheduled<>0
          LIMIT 1
        `), 'Backup habit schedules are inconsistent.');
        const days = this.all('SELECT day FROM days ORDER BY day');
        check(days.length && days[0].day === data.first &&
          days.every((row, index) => index === 0 || row.day === offset(days[index - 1].day, 1)), 'Invalid tracking dates.');
        this.setMeta('settings', settings);
        this.setMeta('first', data.first);
        this.setMeta('generation', token());
        this.run("DELETE FROM metadata WHERE key='backupStatus'");
      });
    } finally {
      sourceKey.fill(0);
    }
  }
}

