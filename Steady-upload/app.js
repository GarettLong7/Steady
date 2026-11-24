import express from 'express';
import helmet from 'helmet';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SteadyModel, check, moods, quickReflectionId, settingsInput, validNoteId } from './models/steady.js';
import { habitIconOptions } from './services/habit-icons.js';
import { dateLabel, localDay, monthInfo, offset, validDay, validMonth, weekStart } from './services/dates.js';
import { credentials, decryptBackup, encryptBackup, token, unlock } from './services/security.js';
import { cooldownSeconds, rateGate, sessionSecurity } from './middleware/session.js';
import { DEFAULT_PORT, listen } from './services/local-server.js';

const root = dirname(fileURLToPath(import.meta.url));
const encouragements = [
  'Small steps still move you forward.',
  'You showed up today. That counts.',
  'Progress doesn’t have to be perfect.',
  'Every day is another opportunity.',
  'Rest is part of taking care of yourself.',
  'One small step is enough to begin.'
];
const postLimit = '65mb';
const strings = input => input && typeof input === 'object' && !Array.isArray(input) ? input : {};
const passwordInput = password => check(typeof password === 'string' && password.length >= 1 && password.length <= 256,
  'Enter your master password.');
function newPassword(password, confirmation) {
  passwordInput(password);
  check(password.length >= 12, 'Use at least 12 characters for your master password.');
  check(password === confirmation, 'The passwords do not match.');
}
function confirmed(input) { check(input.confirm === true, 'Confirm this change first.'); }
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function createApp({ filename = resolve(process.env.STEADY_DATA_DIR || resolve(root, 'data'), 'steady.sqlite'),
  now, secure = false } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const model = new SteadyModel(filename, now);
  const sessions = sessionSecurity(model, secure);
  const gate = rateGate(model);
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', resolve(root, 'views'));
  app.locals.habitIconOptions = habitIconOptions;
  app.use((req, res, next) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(req.get('host') ?? '')) return res.sendStatus(421);
    next();
  });
  app.use(helmet({
    strictTransportSecurity: secure ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': secure ? [] : null, 'form-action': ["'self'"] } }
  }));
  app.use('/assets', express.static(resolve(root, 'public'), { index: false }));
  app.get('/assets/bootstrap.min.css', (req, res) => res.sendFile(resolve(root, 'node_modules/bootstrap/dist/css/bootstrap.min.css')));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(sessions.middleware);
  app.use(express.urlencoded({ extended: false, limit: '12kb' }));
  app.use(['/api/daily','/api/monthly','/api/notes'], express.json({ limit: '13mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      check(safeEqual(req.get('x-csrf-token') ?? req.body?._csrf, req.session.csrf),
        'This page has expired. Reload it and try again.', 403);
    }
    next();
  });

  const renderAuth = (req, res, error, retryAfter = 0) => {
    req.session.csrf ??= token();
    const setup = !model.meta('credential');
    res.render('auth', { setup, csrf: req.session.csrf, error, retryAfter });
  };
  app.get('/auth', (req, res) => {
    if (sessions.lookup(req)) return res.redirect('/');
    const remaining = cooldownSeconds(model);
    renderAuth(req, res, remaining ? 'Too many password attempts.' : undefined, remaining);
  });
  app.post('/auth', async (req, res) => {
    const input = strings(req.body);
    try {
      const key = await gate(async () => {
        const stored = model.meta('credential');
        if (stored) {
          passwordInput(input.password);
          const unlocked = await unlock(input.password, stored);
          check(unlocked, 'Incorrect master password.', 401);
          return unlocked;
        }
        newPassword(input.password, input.confirmation);
        const dek = randomBytes(32);
        try {
          model.setup(await credentials(input.password, dek));
          return dek;
        } catch (error) {
          dek.fill(0);
          throw error;
        }
      });
      await sessions.enter(req, key);
      res.redirect(303, '/');
    } catch (error) {
      if (!error.public) throw error;
      res.status(error.status);
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      renderAuth(req, res, error.message, error.retryAfter);
    }
  });

  app.use((req, res, next) => {
    const activity = req.path !== '/api/session';
    const key = sessions.lookup(req, activity);
    if (!key) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Steady is locked. Unlock it to continue.', locked: true });
      return res.redirect('/auth');
    }
    req.key = key;
    model.migrateWriting(key);
    req.today = model.today();
    model.materializeThrough(req.today);
    req.session.csrf ??= token();
    res.locals = { ...res.locals, csrf: req.session.csrf, today: req.today, path: req.path,
      dateLabel, moods };
    next();
  });

  app.post('/lock', async (req, res) => { await sessions.leave(req, res); res.redirect(303, '/auth'); });
  app.post('/api/lock', async (req, res) => { await sessions.leave(req, res); res.sendStatus(204); });
  app.get('/api/session', (req, res) => res.json({ unlocked: true, csrf: req.session.csrf, today: req.today }));
  app.post('/api/activity', (req, res) => res.sendStatus(204));
  const chooseMonth = req => {
    const month = req.query.month ?? (validDay(req.query.day) ? req.query.day : req.today).slice(0, 7);
    check(typeof month === 'string' && validDay(month + '-01') &&
      month >= '0002-01' && month <= '9998-12', 'Choose a valid calendar month.');
    return month;
  };
  const dateLinks = (day, today, first, base, mode = '') => {
    const url = date => base + (date ? '?day=' + date + mode : (mode ? '?' + mode.slice(1) : ''));
    return {
      previous: day > first ? url(offset(day, -1)) : null,
      next: day < today ? url(offset(day, 1)) : null,
      today: url()
    };
  };
  const singaporeDay = () => localDay(new Date(model.now()), 'Asia/Singapore');
  app.get('/', (req, res) => {
    const day = req.query.day ?? req.today;
    const first = model.meta('first');
    model.requireDay(day, req.today);
    res.render('dashboard', {
      title: 'Dashboard', day, daily: model.daily(day), stats: model.statistics(req.today),
      encouragement: encouragements[Math.floor(Date.parse(req.today) / 86400000) % encouragements.length],
      reflection: model.quickReflection(req.key, day, quickReflectionId(day)), generation: model.meta('generation'),
      followsToday: req.query.day === undefined, dates: dateLinks(day, req.today, first, '/'),
      habitIcons: model.dashboardHabitIcons(day === req.today)
    });
  });
  app.get('/notes', (req, res) => {
    const page = Number(req.query.page ?? 1);
    check(Number.isSafeInteger(page) && page > 0 && page <= 100000, 'Choose a valid notes page.');
    res.render('notes', { title: 'Notes', page, ...model.notes(req.key, page) });
  });
  app.get('/notes/new', (req, res) => {
    const note = { id: randomBytes(16).toString('hex'), title: '', body: '', event_day: '', version: 0 };
    res.render('note', { title: 'New note', note, generation: model.meta('generation') });
  });
  app.get('/notes/:id', (req, res) => {
    check(validNoteId(req.params.id), 'Note not found.', 404);
    const note = model.note(req.key, req.params.id);
    check(note, 'Note not found.', 404);
    res.render('note', { title: 'Note', note, generation: model.meta('generation') });
  });
  app.get('/history', (req, res) => {
    const month = chooseMonth(req);
    const day = req.query.day ?? (month === req.today.slice(0, 7) ? req.today : null);
    check(!day || validDay(day), 'Choose a valid date.');
    const tracked = day && day <= req.today && !!model.get('SELECT 1 FROM days WHERE day=?', day);
    res.render('history', { title: 'History', day, calendar: model.calendar(month, req.today),
      daily: tracked ? model.daily(day) : null, quick: tracked ? model.quickReflection(req.key, day, quickReflectionId(day)) : null });
  });
  app.get('/statistics', (req, res) => {
    const selected = req.query.week ?? req.today;
    check(validDay(selected) && selected >= '0002-01-01' && selected <= req.today, 'Choose a valid week through today.');
    const start = weekStart(selected);
    const current = weekStart(req.today);
    res.render('statistics', { title: 'Statistics', day: null, stats: model.statistics(req.today),
      weekly: model.weeklySummary(start, req.today), calendar: model.calendar(req.today.slice(0, 7), req.today),
      previousWeek: start >= '0002-01-08' ? offset(start, -7) : null, nextWeek: start < current ? offset(start, 7) : null });
  });
  app.get('/monthly', (req, res) => {
    const currentMonth = singaporeDay().slice(0, 7);
    const month = req.query.month ?? currentMonth;
    check(validMonth(month) && month <= currentMonth, 'Choose a month through this month.');
    res.render('monthly', { title: 'Monthly reflection', month, calendar: monthInfo(month),
      reflection: model.monthlyReflection(req.key, month), generation: model.meta('generation'), currentMonth });
  });
  app.get('/settings', (req, res) => {
    const settings = model.meta('settings');
    const backupStatus = model.meta('backupStatus') ?? {};
    const interval = settings.backupInterval ?? 14;
    const lastBackupDate = backupStatus.lastSuccess ? localDay(new Date(backupStatus.lastSuccess), settings.timezone) : null;
    res.render('settings', { title: 'Settings', settings, habits: model.habitSettings(), backupStatus, lastBackupDate,
      backupDue: interval > 0 && (!lastBackupDate || offset(lastBackupDate, interval) <= req.today) });
  });

  app.get('/api/habits', (req, res) => res.json(model.manageableHabits()));
  app.post('/api/habits', (req, res) => { model.saveHabit(strings(req.body), req.today); res.sendStatus(204); });
  app.delete('/api/habits', (req, res) => {
    const input = strings(req.body);
    confirmed(input);
    model.deleteHabit(input.id, req.today);
    res.sendStatus(204);
  });
  app.post('/api/habits/reorder', (req, res) => {
    model.reorder(req.body?.id, req.body?.direction); res.sendStatus(204);
  });
  app.post('/api/habits/defaults', (req, res) => {
    confirmed(strings(req.body)); model.transaction(() => model.restoreDefaults()); res.sendStatus(204);
  });
  app.put('/api/completions', (req, res) => {
    const { day, habit, completed } = strings(req.body);
    const daily = model.setCompletion(day, habit, completed, req.today);
    res.json({ ...daily, streak: model.statistics(req.today).current });
  });
  app.put('/api/mood', (req, res) => {
    model.setMood(req.body?.day, req.body?.mood, req.today); res.sendStatus(204);
  });
  app.post('/api/search', (req, res) => {
    const { day = '', q = '', type = '' } = strings(req.body);
    check((day === '' || validDay(day)) && typeof q === 'string' && q.length <= 200 && ['', 'daily', 'note'].includes(type),
      'Choose a valid search filter.');
    res.json(model.searchWriting(req.key, q, day, type, req.today));
  });
  app.put('/api/daily/:day', (req, res) => {
    const day = req.params.day;
    check(validDay(day), 'Choose a valid date.');
    const id = quickReflectionId(day);
    const { title } = model.quickReflection(req.key, day, id);
    return res.json(model.saveJournal(req.key, id, { ...strings(req.body), day, mode: 'free', title }, req.today));
  });
  app.put('/api/monthly/:month', (req, res) =>
    res.json(model.saveMonthlyReflection(req.key, req.params.month,
      { ...strings(req.body), proud: '', learned: '', next: '' }, singaporeDay().slice(0, 7))));
  app.put('/api/notes/:id', (req, res) => res.json(model.saveNote(req.key, req.params.id, strings(req.body))));
  app.delete('/api/notes/:id', (req, res) => {
    const input = strings(req.body);
    confirmed(input);
    check(validNoteId(req.params.id), 'Note not found.', 404);
    model.deleteNote(req.params.id, input.version, input.generation);
    res.sendStatus(204);
  });
  app.get('/api/history', (req, res) => {
    const month = chooseMonth(req);
    const day = req.query.day;
    if (day !== undefined) model.requireDay(day, req.today);
    res.json({ calendar: model.calendar(month, req.today),
      daily: day ? model.daily(day) : null, reflection: day ? model.quickReflection(req.key, day, quickReflectionId(day)) : null });
  });
  app.get('/api/statistics', (req, res) => res.json(model.statistics(req.today)));
  app.post('/api/challenge', (req, res) => {
    confirmed(strings(req.body));
    model.run('INSERT INTO challenges(started) VALUES (?)', req.today);
    res.sendStatus(204);
  });
  app.put('/api/settings', (req, res) => {
    const settings = settingsInput(strings(req.body));
    const interval = model.meta('settings').backupInterval;
    if (settings.backupInterval === undefined && interval !== undefined) settings.backupInterval = interval;
    const newToday = localDay(new Date(model.now()), settings.timezone);
    check(newToday >= model.meta('first'), 'This timezone is still on the day before you started tracking. Try again tomorrow.');
    model.setMeta('settings', settings);
    sessions.lookup(req, true);
    res.sendStatus(204);
  });

  const reauthenticate = async (req, password) => {
    passwordInput(password);
    const key = await gate(async () => {
      const candidate = await unlock(password, model.meta('credential'));
      check(candidate, 'Incorrect master password.', 401);
      return candidate;
    });
    key.fill(0);
    check(sessions.lookup(req), 'Steady is locked. Unlock it to continue.', 401);
  };

  app.post('/api/password', async (req, res) => {
    const { password, next, confirmation } = strings(req.body);
    newPassword(next, confirmation);
    await reauthenticate(req, password);
    const prior = model.meta('credential').hash;
    const proposed = await credentials(next, req.key);
    check(sessions.lookup(req) && model.meta('credential').hash === prior, 'The session or password changed. Try again.', 409);
    model.transaction(() => {
      model.setMeta('credential', proposed);
      sessions.revokeOthers(req.sessionID);
    });
    res.sendStatus(204);
  });
  app.post('/api/backup', async (req, res) => {
    try {
      const { password, backupPassword, backupConfirmation } = strings(req.body);
      newPassword(backupPassword, backupConfirmation);
      await reauthenticate(req, password);
      const backup = await encryptBackup(backupPassword, model.backup(req.key));
      check(sessions.lookup(req), 'Steady is locked. Unlock it to continue.', 401);
      check(Buffer.byteLength(JSON.stringify(backup)) <= 64 * 1024 * 1024, 'This dataset exceeds the current backup size limit.', 413);
      model.setMeta('backupStatus', { result: 'generated', lastSuccess: new Date(model.now()).toISOString() });
      res.attachment('steady-' + req.today + '.steady').json(backup);
    } catch (error) {
      model.setMeta('backupStatus', { ...model.meta('backupStatus'), result: 'failed' });
      throw error;
    }
  });
  app.post('/api/restore', express.raw({ type: 'application/octet-stream', limit: postLimit }), async (req, res) => {
    check(Buffer.isBuffer(req.body), 'Select a Steady backup file.');
    // A binary request carries one JSON document with the encrypted file and its passwords.
    let input;
    try { input = strings(JSON.parse(req.body.toString())); } catch { check(false, 'Invalid backup request.'); }
    confirmed(input);
    await reauthenticate(req, input.password);
    passwordInput(input.backupPassword);
    let backup;
    try { backup = await decryptBackup(input.backupPassword, JSON.parse(input.file)); }
    catch { check(false, 'The backup could not be opened. Check the file and backup password.'); }
    check(sessions.lookup(req), 'Steady is locked. Unlock it to continue.', 401);
    try { model.restore(backup, req.key); }
    catch { check(false, 'The backup records are invalid. Your existing data was preserved.'); }
    sessions.lookup(req, true);
    res.sendStatus(204);
  });
  app.post('/api/markdown', async (req, res) => {
    confirmed(strings(req.body));
    await reauthenticate(req, req.body.password);
    const lines = ['# Steady Journal', ''];
    const labels = { daily: 'Daily reflection', monthly: 'Monthly reflection', note: 'Personal note' };
    for (const row of model.writingRows(req.today)) {
      const { title, body } = model.writingContent(req.key, row);
      lines.push('## ' + row.date, '', '### ' + (row.type === 'note' && title ? title : labels[row.type]), '', body, '');
    }
    res.attachment('steady-journal.md').type('text/markdown').send(lines.join('\n'));
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'This resource was not found.' });
    res.status(404).render('error', { message: 'This page was not found.' });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.public ? error.status : error.type === 'entity.too.large' ? 413 : error.status === 400 ? 400 : 500;
    const message = error.public ? error.message : status === 413 ? 'This request is too large.' :
      status === 400 ? 'The request could not be read.' : 'Steady could not complete this request. Please try again.';
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    if (req.path.startsWith('/api/')) return res.status(status).json({
      error: error.retryAfter ? message + ' Try again in ' + error.retryAfter + ' seconds.' : message
    });
    res.status(status).render('error', { message });
  });
  return { app, model, close() { sessions.close(); model.db.close(); } };
}

export { listen };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cert = process.env.STEADY_TLS_CERT;
  const key = process.env.STEADY_TLS_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error('Set both STEADY_TLS_CERT and STEADY_TLS_KEY.');
  const tls = cert ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
  const port = Number(process.env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const steady = createApp({ secure: !!tls });
  const server = listen(steady.app, { port, tls });
  server.on('listening', () => {
    console.log('Steady is ready at ' + (tls ? 'https' : 'http') + '://127.0.0.1:' + port);
    console.log('Working directory: ' + process.cwd());
    console.log('SQLite database: ' + steady.model.db.location('main'));
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'That port is already in use. Stop the other server or set PORT.' : 'Steady could not start.');
    steady.close();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close(() => steady.close()));
}

