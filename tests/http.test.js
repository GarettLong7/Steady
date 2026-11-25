import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, listen } from '../app.js';
import { resetEmptySetup } from '../services/reset-setup.js';
import { DatabaseSync } from 'node:sqlite';
import { draftSaver } from '../public/draft.js';
import { unlock } from '../services/security.js';
import { habitIconOptions } from '../services/habit-icons.js';

const password = 'Steady temporary password';
const nextPassword = 'Steady second password';
const backupPassword = 'Steady backup password';

test('History keyword search finds older daily reflection text and returns literal match excerpts', async t => {
  const f = await fixture(t);
  const original = f.client();
  assert.equal((await original.auth(password, password)).status, 303);
  const save = (client, day, body) => client.request('/api/daily/' + day, {
    method: 'PUT', json: { body, version: 0, generation: f.model.meta('generation') }
  });
  const old = '2026-11-23';
  assert.equal((await save(original, old, 'Warm-up notes. '.repeat(25) + 'Stretching felt good. Effort 50%_done.')).status, 200);
  f.advance(31 * 86400000);
  const client = f.client();
  assert.equal((await client.auth(password)).status, 303);
  const today = f.model.today();
  assert.equal((await save(client, today, 'Shorter stretching session.')).status, 200);
  const month = await client.request('/history?month=' + today.slice(0, 7));
  assert.match(await month.text(), /Search reflections[\s\S]+data-search-clear/);
  const search = async q => (await (await client.request('/api/search', { method: 'POST', json: { q, type: 'daily' } })).json()).entries;
  assert.deepEqual((await search(' stretching ')).map(entry => entry.date), [today, old]);
  const [result] = await search('STRETCHING FELT GOOD');
  assert.equal(result.href, '/?day=' + old);
  assert.match(result.preview, /Stretching felt good/);
  assert.equal((await search('%_'))[0].date, old);
  assert.deepEqual(await search('50X_done'), []);
});

test('daily habit icon creation and editing update Today without changing the checklist', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  const day = f.model.today();
  const save = json => client.request('/api/habits', { method: 'POST', json });
  const dailyHabit = { description: '', minutes: 5, active: true, kind: 'daily' };
  assert.equal((await save({ ...dailyHabit, name: 'Daily Stretching' })).status, 204);
  assert.equal((await save({ ...dailyHabit, name: 'New daily habit', icon: 'skill' })).status, 204);
  assert.equal((await save({ ...dailyHabit, name: 'Invalid icon', icon: 'constructor' })).status, 400);
  const stretch = f.model.habitSettings().find(habit => habit.name === 'Daily Stretching');
  const added = f.model.habitSettings().find(habit => habit.name === 'New daily habit');
  const row = (html, id) => html.split('data-habit="' + id + '"')[1].split('</label>')[0];
  const dashboard = async () => (await client.request('/')).text();
  const before = await dashboard();
  assert.ok(row(before, stretch.id).includes(habitIconOptions.plus.path));
  assert.ok(row(before, added.id).includes(habitIconOptions.skill.path));
  for (const { id, default_key } of f.model.habits().filter(habit => habit.default_key)) {
    assert.ok(row(before, id).includes(habitIconOptions[default_key].path));
  }
  const settings = await (await client.request('/settings')).text();
  assert.match(settings, /<legend>Icon<\/legend>/);
  assert.match(settings, /name="icon" value="skill" checked/);
  assert.match(settings, /name="icon" value="plus" checked/);
  f.model.setCompletion(day, stretch.id, true, day);
  const checklist = f.model.daily(day);
  assert.equal((await save({ ...dailyHabit, id: stretch.id, name: stretch.name, icon: 'physical' })).status, 204);
  const after = await dashboard();
  assert.match(row(after, stretch.id), /checked/);
  assert.ok(row(after, stretch.id).includes(habitIconOptions.physical.path));
  assert.deepEqual(f.model.daily(day), checklist);
});

test('Settings habit deletion requires confirmation and preserves existing check-offs', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  const day = f.model.today();
  const [completed, unchecked] = f.model.daily(day).habits;
  f.model.setCompletion(day, completed.habit, true, day);
  const remove = (id, confirm) => client.request('/api/habits', { method: 'DELETE', json: { id, confirm } });
  assert.equal((await remove(unchecked.habit, false)).status, 400);
  assert.equal((await remove(unchecked.habit, true)).status, 204);
  assert.equal((await remove(completed.habit, true)).status, 204);
  const settings = await (await client.request('/settings')).text();
  assert.doesNotMatch(settings, /<strong>(Physical Health|Vietnamese Practice)<\/strong>/);
  assert.match(settings, /Delete habit/);
  assert.equal(f.model.daily(day).total, 3);
  assert.equal(f.model.daily(day).done, 1);
  assert.ok(f.model.daily(day).habits.some(row => row.habit === completed.habit && row.completed));
  f.model.materializeThrough('2026-11-24');
  assert.equal(f.model.daily('2026-11-24').total, 2);
});

test('Today repairs an enabled legacy habit that never acquired a plan', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  const day = '2026-11-23';
  const { habit } = f.model.daily(day).habits[0];
  f.model.setCompletion(day, habit, true, day);
  const insert = (name, enabled) => f.model.run(
    'INSERT INTO habits(name,description,minutes,active,position) VALUES (?,?,?,?,9)', name, '', 5, enabled
  ).lastInsertRowid;
  const stretching = insert('Daily Stretching', 1);
  const disabled = insert('Disabled legacy habit', 0);
  assert.equal(f.model.daily(day).total, 4);
  for (let refresh = 0; refresh < 2; refresh++) {
    const dashboard = await (await client.request('/')).text();
    assert.match(dashboard, /1 of 5 completed/);
    assert.equal(dashboard.split('data-habit="' + stretching + '"').length - 1, 1);
    assert.doesNotMatch(dashboard, new RegExp('data-habit="' + disabled + '"'));
  }
  assert.equal(f.model.daily(day).habits.find(row => row.habit === habit).completed, 1);
  assert.equal(f.model.daily(day).habits.find(row => row.habit === stretching).completed, 0);
});

test('a new active habit joins today’s checklist without changing earlier days or check-offs', async t => {
  const f = await fixture(t);
  assert.equal((await f.client().auth(password, password)).status, 303);
  // It is already November 24 in Singapore while UTC is still November 23.
  f.advance(15 * 60 * 60 * 1000);
  const client = f.client();
  assert.equal((await client.auth(password)).status, 303);
  const day = '2026-11-24';
  const id = f.model.habits()[0].id;
  const complete = habit => client.request('/api/completions', { method: 'PUT', json: { day, habit, completed: true } });
  const dashboard = async () => (await client.request('/')).text();
  assert.equal((await complete(id)).status, 200);
  assert.match(await dashboard(), /1 of 4 completed/);
  const previous = f.model.daily('2026-11-23');
  assert.equal((await client.request('/api/habits', {
    method: 'POST', json: { name: 'Stretching', description: '', minutes: 5, active: true, kind: 'daily' }
  })).status, 204);
  assert.match(await (await client.request('/settings')).text(), /<strong>Stretching<\/strong>/);
  const stretch = f.model.habits().find(habit => habit.name === 'Stretching').id;
  const checkbox = habit => new RegExp('data-habit="' + habit + '"[^>]*>');
  const fresh = await dashboard();
  assert.equal(fresh.split('data-habit="' + stretch + '"').length - 1, 1);
  assert.match(fresh, /1 of 5 completed/);
  assert.match(fresh.match(checkbox(id))[0], /checked/);
  assert.doesNotMatch(fresh.match(checkbox(stretch))[0], /checked/);
  const updated = await (await complete(stretch)).json();
  assert.equal(updated.percentage, 40);
  const reloaded = await dashboard();
  assert.match(reloaded, /2 of 5 completed/);
  assert.match(reloaded.match(checkbox(id))[0], /checked/);
  assert.match(reloaded.match(checkbox(stretch))[0], /checked/);
  assert.deepEqual(f.model.daily('2026-11-23'), previous);
});

async function fixture(t, existingFolder) {
  const folder = existingFolder ?? mkdtempSync(join(tmpdir(), 'steady-http-'));
  let clock = Date.parse('2026-11-23T02:00Z');
  const steady = createApp({ filename: join(folder, 'steady.sqlite'), now: () => clock });
  const server = listen(steady.app, { port: 0 });
  let closed = false;
  async function stop() {
    if (closed) return;
    closed = true;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    steady.close();
  }
  t.after(async () => {
    await stop();
    if (!existingFolder) rmSync(folder, { recursive: true, force: true });
  });
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  const address = 'http://127.0.0.1:' + server.address().port;
  return {
    ...steady, address, stop, folder,
    advance: milliseconds => { clock += milliseconds; },
    client() {
      let cookie, csrf;
      const request = async (path, options = {}) => {
        const headers = new Headers(options.headers);
        if (cookie) headers.set('cookie', cookie);
        if (csrf && !options.omitCSRF) headers.set('x-csrf-token', csrf);
        if (options.json) headers.set('content-type', 'application/json');
        if (options.form) headers.set('content-type', 'application/x-www-form-urlencoded');
        const response = await fetch(address + path, { method: options.method, headers, redirect: 'manual',
          body: options.json ? JSON.stringify(options.json) : options.form ? new URLSearchParams(options.form) : options.body });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';', 1)[0];
        return response;
      };
      return {
        request,
        cookie: () => cookie,
        async auth(value, confirmation) {
          const page = await request('/auth');
          csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
          assert.ok(csrf);
          const result = await request('/auth', { method: 'POST', form: { password: value, confirmation: confirmation ?? '' } });
          if (result.status === 303) {
            const active = await request('/api/session');
            assert.equal(active.status, 200);
            csrf = (await active.json()).csrf;
          }
          return result;
        }
      };
    }
  };
}

test('setup, login, CSRF, persistent session storage, password change, lock, and idle timeout', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.request('/api/habits')).status, 401);
  assert.equal((await client.request('/')).headers.get('location'), '/auth');
  assert.equal((await client.auth('short', 'short')).status, 400);
  const initialCookie = client.cookie();
  const setup = await client.auth(password, password);
  assert.equal(setup.status, 303);
  assert.notEqual(client.cookie(), initialCookie);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(f.model.get('SELECT count(*) AS count FROM sessions').count, 1);
  assert.ok(!f.model.get('SELECT data FROM sessions').data.includes(f.model.meta('credential').wrapped));
  for (const path of ['/','/notes','/history','/statistics','/settings']) {
    const response = await client.request(path);
    assert.equal(response.status, 200, path + ' ' + await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    if (path === '/settings') {
      const html = await response.text();
      const inputs = [...html.matchAll(/type="password" id="([^"]+)"/g)].map(match => match[1]);
      const controls = [...html.matchAll(/data-password-toggle aria-controls="([^"]+)"/g)].map(match => match[1]);
      assert.equal(new Set(inputs).size, 9);
      assert.deepEqual(controls, inputs);
    }
  }
  assert.equal((await client.request('/assets/bootstrap.min.css')).status, 200);
  assert.equal((await client.request('/api/completions', { method: 'PUT', json: {}, omitCSRF: true })).status, 403);
  assert.equal((await client.request('/api/completions', { method: 'PUT', json: {} })).status, 400);
  const other = f.client();
  assert.equal((await other.auth('incorrect')).status, 401);
  assert.equal((await other.auth(password)).status, 303);
  assert.equal((await client.request('/api/password', { method: 'POST',
    json: { password, next: nextPassword, confirmation: nextPassword } })).status, 204);
  assert.equal((await other.request('/api/habits')).status, 401);
  assert.equal((await client.request('/lock', { method: 'POST' })).status, 303);
  assert.equal((await client.request('/api/habits')).status, 401);
  assert.equal((await client.auth(password)).status, 401);
  assert.equal((await client.auth(nextPassword)).status, 303);
  f.advance(14 * 60000);
  assert.equal((await client.request('/api/session')).status, 200);
  f.advance(60001);
  assert.equal((await client.request('/api/session')).status, 401);
  assert.equal((await client.request('/api/search', { method: 'POST', json: {} })).status, 403);
});

test('notes can be created, edited, searched, deleted and restored without exposing plaintext at rest', async t => {
  const origin = await fixture(t);
  const destination = await fixture(t);
  const client = origin.client();
  const second = destination.client();
  await client.auth(password, password);
  await second.auth(nextPassword, nextPassword);
  const generation = origin.model.meta('generation');
  const form = await (await client.request('/notes/new')).text();
  assert.match(form, /Focus Writing/);
  const id = form.match(/data-endpoint="\/api\/notes\/([a-f0-9]{32})"/)[1];
  const entry = { eventDay: '2026-11-23', title: '<script>alert(42)</script>',
    body: 'Searchable personal sample\n\nSecond paragraph', version: 0, generation };
  const route = '/api/notes/' + id;
  assert.equal((await client.request(route, { method: 'PUT', json: entry })).status, 200);
  assert.equal((await client.request('/api/notes/' + 'b'.repeat(32), { method: 'PUT',
    json: { ...entry, title: 'Another note' } })).status, 200);
  assert.deepEqual(await (await client.request(route, { method: 'PUT', json: entry })).json(), { version: 1 });
  assert.equal((await client.request(route, { method: 'PUT', json: { ...entry, body: 'Stale edit' } })).status, 409);
  const edited = await client.request(route, { method: 'PUT', json: { ...entry, version: 1, eventDay: '2026-10-23' } });
  assert.deepEqual(await edited.json(), { version: 2 });
  const note = await (await client.request('/notes/' + id)).text();
  assert.ok(note.includes('&lt;script&gt;alert(42)&lt;/script&gt;'));
  assert.ok(!note.includes(entry.title));
  assert.match(note, /Searchable personal sample\n\nSecond paragraph/);
  assert.doesNotMatch(origin.model.get('SELECT ciphertext FROM personal_notes WHERE id=?', id).ciphertext, /script|Searchable personal sample/);
  const results = await client.request('/api/search', { method: 'POST', json: { q: 'alert(42)', type: 'note', day: '2026-10-23' } });
  assert.deepEqual((await results.json()).entries.map(item => [item.kind, item.title, item.href]),
    [['note', entry.title, '/notes/' + id]]);
  assert.match(await (await client.request('/notes')).text(), /Another note/);
  const backup = await client.request('/api/backup', { method: 'POST',
    json: { password, backupPassword, backupConfirmation: backupPassword } });
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get('content-disposition'), /\.steady/);
  const file = await backup.text();
  assert.ok(!file.includes(entry.body));
  const restore = pass => second.request('/api/restore', { method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: JSON.stringify({ confirm: true, file, password: nextPassword, backupPassword: pass }) });
  assert.equal((await restore('Wrong backup password')).status, 400);
  assert.equal((await restore(backupPassword)).status, 204);
  assert.match(await (await second.request('/notes/' + id)).text(), /Searchable personal sample/);
  const markdown = await second.request('/api/markdown', { method: 'POST', json: { confirm: true, password: nextPassword } });
  assert.match(markdown.headers.get('content-disposition'), /\.md/);
  assert.match(await markdown.text(), /Searchable personal sample/);
  const remove = confirm => second.request(route, { method: 'DELETE',
    json: { confirm, version: 2, generation: destination.model.meta('generation') } });
  assert.equal((await remove(false)).status, 400);
  assert.equal((await remove(true)).status, 204);
  assert.equal((await second.request('/notes/' + id)).status, 404);
  assert.equal((await second.request('/notes')).status, 200);
  assert.equal(destination.model.get('SELECT count(*) AS n FROM personal_notes').n, 1);
});

test('repeated invalid passwords receive a rate-limit response', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  await client.request('/lock', { method: 'POST' });
  for (let attempt = 0; attempt < 8; attempt++) assert.equal((await client.auth('incorrect')).status, 401);
  const limited = await client.auth(password);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '300');
  assert.match(await limited.text(), /300 seconds/);
  assert.match(await (await client.request('/auth')).text(), /300 seconds/);
  f.advance(5 * 60 * 1000 + 1);
  assert.equal((await client.auth(password)).status, 303);
});

test('the daily editor preserves its Singapore date across midnight and the pendant assets still load', async t => {
  const f = await fixture(t);
  const client = f.client();
  f.advance(14 * 60 * 60 * 1000 - 2000);
  assert.equal((await client.auth(password, password)).status, 303);
  const prior = await (await client.request('/')).text();
  assert.match(prior, /data-endpoint="\/api\/daily\/2026-11-23"/);
  assert.equal([...prior.matchAll(/<textarea/g)].length, 1);
  f.advance(3000);
  const session = await (await client.request('/api/session')).json();
  assert.equal(session.today, '2026-11-24');
  assert.match(await (await client.request('/')).text(), /data-endpoint="\/api\/daily\/2026-11-24"/);
  const save = await client.request('/api/daily/2026-11-23', { method: 'PUT',
    json: { body: 'Synthetic text from yesterday', version: 0, generation: f.model.meta('generation') } });
  assert.equal(save.status, 200);
  assert.match(await (await client.request('/?day=2026-11-23')).text(), /Synthetic text from yesterday/);
  assert.doesNotMatch(await (await client.request('/')).text(), /Synthetic text from yesterday/);
  const emblem = await client.request('/assets/images/logo_jade_nav.png');
  assert.equal(emblem.status, 200);
  assert.match(emblem.headers.get('content-type'), /image\/png/);
  await emblem.arrayBuffer();
  assert.match(prior, /rel="icon" type="image\/svg\+xml" href="\/assets\/steady-favicon.svg"/);
});

test('Edit yesterday previews default habits and saves the first check-off with its plan', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  const today = f.model.today();
  const yesterday = '2026-11-22';
  const page = async path => {
    const response = await client.request(path);
    assert.equal(response.status, 200);
    return response.text();
  };
  const historyPath = '/history?day=' + yesterday;
  const put = (path, json) => client.request(path, { method: 'PUT', json });
  const custom = { name: 'Started today', description: '', minutes: 5, active: true, kind: 'weekdays', weekdays: 127 };
  assert.equal((await client.request('/api/habits', { method: 'POST', json: custom })).status, 204);
  const historyBefore = await page(historyPath);
  const todayBefore = f.model.daily(today);
  const customId = todayBefore.habits.find(habit => habit.name === custom.name).habit;
  const defaults = f.model.habits().filter(habit => habit.default_key).map(habit => habit.id);
  assert.equal(defaults.length, 4);
  const tracked = () => f.model.get('SELECT day FROM days WHERE day=?', yesterday)?.day;
  assert.equal(tracked(), undefined);
  const dashboard = await page('/');
  assert.match(dashboard, /href="\/\?day=2026-11-22">Edit yesterday<\/a>/);
  const dated = await page('/?day=' + yesterday);
  assert.match(dated, /<h1><time datetime="2026-11-22">Sunday, November 22, 2026<\/time><\/h1>/);
  assert.deepEqual([...dated.matchAll(/data-habit="(\d+)"\s*>/g)].map(match => Number(match[1])), defaults);
  assert.doesNotMatch(dated, /Started today/);
  assert.match(dated, /name="mood" value="" checked/);
  const [, endpoint] = dated.match(/data-endpoint="([^"]+)"[^>]*data-version="0"/);
  assert.equal(endpoint, '/api/daily/' + yesterday);
  assert.match(dated, /name="body"[^>]*>\s*<\/textarea>/);
  assert.equal(tracked(), undefined);
  assert.equal(await page(historyPath), historyBefore);

  const body = 'My first reflection for yesterday.';
  const save = json => put(endpoint, json);
  const draft = { body, version: 0, generation: f.model.meta('generation') };
  assert.equal((await save({ ...draft, generation: 'stale' })).status, 409);
  assert.equal((await put('/api/completions', { day: yesterday, habit: customId, completed: true })).status, 404);
  assert.equal(tracked(), undefined);
  assert.equal((await put('/api/completions', { day: yesterday, habit: defaults[0], completed: true })).status, 200);
  const checked = new RegExp('data-habit="' + defaults[0] + '" checked');
  assert.match(await page('/?day=' + yesterday), checked);
  assert.match(await page(historyPath), checked);
  assert.equal((await put('/api/mood', { day: yesterday, mood: 'Good' })).status, 204);
  assert.equal((await save(draft)).status, 200);
  assert.equal(tracked(), yesterday);
  assert.equal(f.model.meta('first'), yesterday);
  assert.match(await page('/?day=' + yesterday), /My first reflection for yesterday\./);
  assert.match(await page(historyPath), /My first reflection for yesterday\./);
  assert.match(await page(historyPath), /name="mood" value="Good" checked/);
  assert.doesNotMatch(await page('/'), /My first reflection for yesterday\./);
  assert.deepEqual(f.model.daily(today), todayBefore);
  assert.equal(f.model.get('SELECT count(*) AS count FROM daily_plans WHERE day=?', yesterday).count, defaults.length);
  assert.ok(!f.model.get('SELECT ciphertext FROM journals WHERE day=?', yesterday).ciphertext.includes(body));
});

test('yesterday can start with a mood on a fresh database', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  const yesterday = '2026-11-22';
  assert.equal(f.model.get('SELECT 1 FROM days WHERE day=?', yesterday), undefined);
  const response = await client.request('/api/mood', { method: 'PUT', json: { day: yesterday, mood: 'Good' } });
  assert.equal(response.status, 204);
  assert.equal(f.model.daily(yesterday).mood, 'Good');
  assert.equal(f.model.daily(f.model.today()).mood, '');
});

test('Edit yesterday saves the dated check-in just after Singapore midnight', async t => {
  const f = await fixture(t);
  const old = '2026-11-23';
  const yesterday = '2026-11-24';
  const today = '2026-11-25';
  const requestPage = async (client, path) => {
    const response = await client.request(path);
    assert.equal(response.status, 200);
    return response.text();
  };
  const setup = f.client();
  assert.equal((await setup.auth(password, password)).status, 303);
  f.advance(38 * 3600000 + 1000);
  const client = f.client();
  assert.equal((await client.auth(password)).status, 303);
  assert.equal(f.model.today(), today);
  assert.equal((await client.request('/api/habits', { method: 'POST',
    json: { name: 'New today habit', description: '', minutes: 5, active: true, kind: 'daily' } })).status, 204);
  const todayBefore = f.model.daily(today);
  const dashboard = await requestPage(client, '/');
  assert.match(dashboard, /New today habit/);
  const [, editLink] = dashboard.match(/href="([^"]+)">Edit yesterday<\/a>/);
  assert.equal(editLink, '/?day=' + yesterday);
  const page = await requestPage(client, editLink);
  assert.match(page, /<h1><time datetime="2026-11-24">Tuesday, November 24, 2026<\/time><\/h1>/);
  assert.match(page, /href="\/">Back to Today<\/a>/);
  assert.doesNotMatch(page, /New today habit/);
  const [, habitDay, habit] = page.match(/data-tracker data-day="([^"]+)"[\s\S]*?data-habit="(\d+)"\s*>/);
  const [, moodDay] = page.match(/data-mood data-day="([^"]+)"/);
  const [, endpoint, version, generation] = page.match(/data-endpoint="([^"]+)"[^>]+data-version="(\d+)"\s+data-generation="([^"]+)"/);
  assert.equal(habitDay, yesterday);
  assert.equal(moodDay, yesterday);
  assert.equal(endpoint, '/api/daily/' + yesterday);
  assert.equal(version, '0');
  const put = (path, json) => client.request(path, { method: 'PUT', json });
  const completion = { day: habitDay, habit: Number(habit), completed: true };
  assert.equal((await put('/api/completions', completion)).status, 200);
  assert.equal((await put('/api/mood', { day: moodDay, mood: 'Good' })).status, 204);
  const body = 'Finished my check-in after midnight.';
  const reflection = { body, version: Number(version), generation };
  let saveDraft;
  const editor = draftSaver({
    read: () => reflection,
    async write(value) { assert.equal((await put(endpoint, value)).status, 200); },
    schedule(callback) { saveDraft = callback; },
    cancel() {},
    report() {}
  });
  editor.change();
  assert.equal(await saveDraft(), true);
  for (const path of [editLink, '/history?day=' + yesterday]) {
    const reloaded = await requestPage(client, path);
    assert.ok(reloaded.includes('data-habit="' + habit + '" checked'));
    assert.match(reloaded, /name="mood" value="Good" checked/);
    assert.ok(reloaded.includes(body));
  }
  assert.deepEqual(f.model.daily(today), todayBefore);
  assert.ok(!(await requestPage(client, '/')).includes(body));
  const journal = f.model.get('SELECT day,ciphertext FROM journals');
  assert.equal(journal.day, yesterday);
  assert.ok(!journal.ciphertext.includes(body));

  for (const path of ['/?day=' + old, '/history?day=' + old]) {
    const readOnly = await requestPage(client, path);
    assert.match(readOnly, /data-habit="\d+"\s+disabled/);
    assert.match(readOnly, /<fieldset disabled>/);
    assert.doesNotMatch(readOnly, /data-editor|Edit daily reflection|Write a reflection/);
  }
  assert.equal((await put('/api/completions', { ...completion, day: old })).status, 403);
  assert.equal((await put('/api/mood', { day: old, mood: 'Good' })).status, 403);
  assert.equal((await put('/api/daily/' + old, reflection)).status, 403);
});

test('the daily check-in autosaves independently of habits and History searches all three writing types', async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.auth(password, password)).status, 303);
  const day = f.model.today();
  const initial = await (await client.request('/')).text();
  assert.match(initial, /<h1>Today<\/h1>/);
  assert.match(initial, /What happened today\?/);
  assert.match(initial, /href="\/notes\/new">\+ New Note/);
  assert.doesNotMatch(initial, /Save reflection|Write longer entry|Edit guided reflection/);
  assert.match(initial, /class="habit-description"/);
  assert.match(initial, /class="check-in-footer"[\s\S]*?data-streak/);
  const generation = f.model.meta('generation');
  const states = [];
  let scheduled;
  const draft = { body: 'Synthetic outing reflection\n\nAnother paragraph', version: 0, generation };
  const editor = draftSaver({
    read: () => draft,
    async write(value) { assert.equal((await client.request('/api/daily/' + day, { method: 'PUT', json: value })).status, 200); },
    report: message => states.push(message),
    schedule(callback, delay) { assert.equal(delay, 850); scheduled = callback; },
    cancel() {}
  });
  editor.change();
  assert.equal(await scheduled(), true);
  assert.deepEqual(states, ['Unsaved changes', 'Saving…', 'Saved']);
  assert.equal(f.model.daily(day).done, 0);
  const habit = f.model.daily(day).habits[0].habit;
  assert.equal((await client.request('/api/completions', { method: 'PUT', json: { day, habit, completed: true } })).status, 200);
  assert.equal((await client.request('/api/mood', { method: 'PUT', json: { day, mood: 'Good' } })).status, 204);
  assert.equal(f.model.daily(day).done, 1);
  assert.equal(f.model.daily(day).mood, 'Good');
  assert.equal((await client.request('/api/daily/' + day, { method: 'PUT', json: { ...draft, body: 'Stale edit' } })).status, 409);
  assert.equal((await client.request('/api/monthly/2026-11', {
    method: 'PUT', json: { generation, version: 0, body: 'Monthly outing' } })).status, 200);
  const id = 'c'.repeat(32);
  assert.equal((await client.request('/api/notes/' + id, {
    method: 'PUT', json: { generation, version: 0, eventDay: '2025-11-23', title: 'Outing note', body: 'Standalone writing' }
  })).status, 200);
  const history = await (await client.request('/history?day=' + day)).text();
  assert.match(history, /<h1>History<\/h1>\s*<\/section>\s*<section class="panel history-search writing-search"[^>]*>[\s\S]*?data-search-term[\s\S]*?data-search-results hidden[\s\S]*?class="two-column history-main"/);
  assert.equal([...history.matchAll(/<form [^>]*data-search\b/g)].length, 1);
  assert.doesNotMatch(history, /<form [^>]*action="\/api\/search"/);
  assert.match(history, /<a [^>]*class="calendar-day[\s\S]*?data-mood="/);
  assert.match(history, /<form [^>]*data-mood/);
  assert.match(history, /href="\/history">Today<\/a>/);
  assert.match(history, /href="\/statistics">Weekly summary/);
  assert.match(history, /Synthetic outing reflection/);
  const search = async q => (await (await client.request('/api/search', { method: 'POST', json: { q } })).json()).entries;
  assert.deepEqual((await search(' OUTING ')).map(item => item.kind), ['daily','monthly','note']);
  assert.deepEqual((await search('23')).map(item => item.date), ['2026-11-23','2025-11-23']);
  assert.deepEqual((await search('23 November')).map(item => item.kind), ['daily','note']);
  assert.deepEqual((await search('23 Nov 2026')).map(item => item.href), ['/?day=2026-11-23']);
  assert.deepEqual((await search('2026-11-23')).map(item => item.kind), ['daily']);
  assert.deepEqual((await search('November 2026')).map(item => item.kind), ['daily','monthly']);
  assert.deepEqual((await search('2026')).map(item => item.href), ['/?day=2026-11-23','/monthly?month=2026-11']);
  assert.deepEqual((await search('standalone')).map(item => item.href), ['/notes/' + id]);
  assert.deepEqual(await search('no such match'), []);
  assert.equal(f.model.get("SELECT count(*) AS n FROM sqlite_schema WHERE sql LIKE '%USING fts%'").n, 0);
  const newYear = await (await client.request('/history?month=2027-01')).text();
  assert.match(newYear, /href="\/history\?month=2026-12">Previous/);
  assert.match(newYear, /href="\/history\?month=2027-02">Next/);
  assert.match(newYear, /class="calendar-day future"/);
  assert.doesNotMatch(await (await client.request('/statistics')).text(), /Synthetic outing reflection|Standalone writing/);
});

test('weekly goals can be logged on creation day and count separately across Singapore week boundaries', async t => {
  const f = await fixture(t);
  let client = f.client();
  f.advance(4 * 86400000 + 14 * 3600000 - 1000);
  assert.equal((await client.auth(password, password)).status, 303);
  const friday = '2026-11-27';
  const saturday = '2026-11-28';
  const sunday = '2026-11-29';
  const monday = '2026-11-30';
  const daily = f.model.daily(friday);
  const streak = f.model.statistics(friday).current;
  assert.equal((await client.request('/api/habits', {
    method: 'POST', json: { name: 'Swimming', description: '', minutes: 20, active: true, kind: 'weekly', target: 2 }
  })).status, 204);
  const { id } = f.model.habits().find(item => item.name === 'Swimming');
  assert.equal(f.model.daily(friday).optional.find(item => item.habit === id).weekly.goal, 2);
  // Reproduce an already-created Phase 3 habit that missed today's snapshot.
  f.model.run('DELETE FROM daily_plans WHERE day=? AND habit=?', friday, id);
  const today = () => client.request('/').then(response => response.text());
  const progress = (done, max = 2) => new RegExp('data-week-progress="' + id + '"[^>]*>' + done + ' / ' + max + ' days this week');
  const checkbox = checked => new RegExp('data-habit="' + id + '"\\s*' + (checked ? 'checked' : '') + '>');
  const firstPage = await today();
  assert.match(firstPage, /<h3>Weekly goals<\/h3>/);
  assert.match(firstPage, /<span>Swimming<\/span>/);
  assert.match(firstPage, progress(0));
  assert.match(firstPage, checkbox(false));
  assert.match(firstPage, new RegExp('data-week-meter="' + id + '" max="2" value="0"'));
  const check = async (day, completed) => {
    const result = await client.request('/api/completions', { method: 'PUT', json: { day, habit: id, completed } });
    assert.equal(result.status, 200);
    const state = await result.json();
    assert.equal(state.total, daily.total);
    assert.equal(state.done, daily.done);
    assert.equal(state.percentage, daily.percentage);
    assert.equal(state.streak, streak);
    return state.optional.find(item => item.habit === id);
  };
  assert.equal((await check(friday, true)).weekly.completed, 1);
  assert.equal((await check(friday, true)).weekly.completed, 1);
  assert.match(await today(), checkbox(true));
  assert.match(await today(), progress(1));
  assert.equal((await check(friday, false)).weekly.completed, 0);
  assert.match(await today(), checkbox(false));
  await check(friday, true);

  for (const day of [saturday, sunday]) {
    f.advance(86400000);
    client = f.client();
    assert.equal((await client.auth(password)).status, 303);
    assert.equal((await check(day, true)).weekly.completed, day === saturday ? 2 : 3);
  }
  assert.match(await today(), progress(3));
  assert.match(await today(), new RegExp('data-week-meter="' + id + '" max="2" value="2"'));
  f.advance(2000);
  assert.equal(f.model.today(), monday);
  assert.match(await today(), progress(0));
  assert.match(await today(), checkbox(false));
  const history = () => client.request('/history?day=' + sunday).then(response => response.text());
  assert.match(await history(), checkbox(true));
  assert.match(await history(), progress(3));
  assert.equal((await check(sunday, false)).weekly.completed, 2);
  assert.match(await history(), checkbox(false));
  assert.match(await history(), progress(2));
  assert.match(await today(), progress(0));
  assert.deepEqual(f.model.all('SELECT day FROM extra_completions WHERE habit=? ORDER BY day', id).map(row => row.day), [friday, saturday]);
  assert.equal(f.model.weeklySummary('2026-11-23', monday).habits.find(item => item.name === 'Swimming').weeklyCompleted, 2);
  assert.equal(f.model.get('SELECT count(*) AS n FROM snapshots WHERE habit=?', id).n, 0);
});

test('monthly writing follows Singapore boundaries and backups retain encrypted reflections and flexible plans', async t => {
  const f = await fixture(t);
  const client = f.client();
  f.advance(7 * 86400000 + 14 * 3600000 - 1000);
  assert.equal((await client.auth(password, password)).status, 303);
  const november = await (await client.request('/monthly')).text();
  assert.match(november, /value="2026-11"/);
  assert.equal([...november.matchAll(/<textarea/g)].length, 1);
  assert.match(november, /What went well this month/);
  const generation = f.model.meta('generation');
  const reflection = { version: 0, generation, body: 'Monthly synthetic private text' };
  const body = { method: 'PUT', json: reflection };
  assert.equal((await client.request('/api/monthly/2026-11', { ...body, omitCSRF: true })).status, 403);
  assert.equal((await client.request('/api/monthly/2026-12', body)).status, 400);
  assert.equal((await client.request('/api/monthly/2026-11', body)).status, 200);
  assert.equal((await client.request('/api/monthly/2026-11', body)).status, 200);
  assert.equal((await client.request('/api/monthly/2026-11', {
    method: 'PUT', json: { ...reflection, version: 1, body: reflection.body + '\n\nA later paragraph' }
  })).status, 200);
  assert.doesNotMatch(f.model.get('SELECT ciphertext FROM monthly_reflections').ciphertext, /Monthly synthetic private text/);
  assert.equal((await client.request('/api/habits', {
    method: 'POST', json: { name: 'Practice guitar', description: '', active: true, minutes: 20, kind: 'weekly', target: 3 }
  })).status, 204);
  f.advance(2000);
  assert.match(await (await client.request('/monthly')).text(), /value="2026-12"/);
  const saved = await client.request('/monthly?month=2026-11');
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.match(await saved.text(), /A later paragraph/);
  assert.doesNotMatch(await (await client.request('/notes')).text(), /Monthly synthetic private text/);
  assert.match(await (await client.request('/notes/new')).text(), /Focus Writing/);
  const css = await (await client.request('/assets/steady.css')).text();
  assert.match(css, /prefers-reduced-motion:no-preference/);
  const guitar = f.model.habits().find(habit => habit.name === 'Practice guitar');
  assert.equal((await client.request('/api/completions', {
    method: 'PUT', json: { day: '2026-12-01', habit: guitar.id, completed: true }
  })).status, 200);
  assert.match(await (await client.request('/')).text(), /1 \/ 3 days this week/);
  let settings = await (await client.request('/settings')).text();
  assert.match(settings, /Every 14 days/);
  assert.match(settings, /It may be time for an encrypted backup/);
  const backupInput = { password, backupPassword, backupConfirmation: backupPassword };
  const generated = await client.request('/api/backup', { method: 'POST', json: backupInput });
  assert.equal(generated.status, 200);
  const backupFile = await generated.text();
  assert.match(backupFile, /steady-backup-v1/);
  assert.doesNotMatch(backupFile, /Monthly synthetic private text/);
  assert.equal((await client.request('/api/backup', { method: 'POST', json: { ...backupInput, backupConfirmation: '' } })).status, 400);
  settings = await (await client.request('/settings')).text();
  assert.match(settings, /Last encrypted backup generated/);
  assert.match(settings, /last generation attempt failed/);
  assert.match(settings, /confirm you retained the file/);
  assert.doesNotMatch(settings, /It may be time for an encrypted backup/);
  const destination = await fixture(t);
  const restored = destination.client();
  await restored.auth(nextPassword, nextPassword);
  assert.equal((await restored.request('/api/restore', { method: 'POST', headers: { 'content-type': 'application/octet-stream' },
    body: JSON.stringify({ confirm: true, file: backupFile, password: nextPassword, backupPassword }) })).status, 204);
  assert.match(await (await restored.request('/monthly?month=2026-11')).text(), /A later paragraph/);
  assert.equal(destination.model.habitSettings().find(habit => habit.name === 'Practice guitar').target, 3);
  assert.equal(destination.model.daily('2026-12-01').extraDone, 1);
  assert.equal(destination.model.meta('backupStatus'), null);
});

test('the first authenticated visit verifies and exposes a preserved longer entry as a Note', async t => {
  const f = await fixture(t);
  const client = f.client();
  await client.auth(password, password);
  const key = await unlock(password, f.model.meta('credential'));
  t.after(() => key.fill(0));
  const id = 'b'.repeat(32);
  const day = f.model.today();
  const legacy = f.model.saveJournal(key, id, {
    day, mode: 'free', title: 'Legacy title', body: 'Legacy text\n\nSecond paragraph',
    version: 0, generation: f.model.meta('generation')
  }, day);
  const old = f.model.get('SELECT ciphertext FROM journals WHERE id=?', id).ciphertext;
  assert.equal((await client.request('/lock', { method: 'POST' })).status, 303);
  f.model.setMeta('writingMigration', null);
  assert.equal((await client.request('/notes')).status, 302);
  assert.equal(f.model.get('SELECT count(*) AS n FROM personal_notes').n, 0);
  await client.auth(password);
  assert.match(await (await client.request('/notes/' + id)).text(), /Legacy text\n\nSecond paragraph/);
  assert.deepEqual(f.model.meta('writingMigration'), { notes: 1, daily: 0, guidedNotes: 0, monthly: 0 });
  assert.equal(f.model.get('SELECT ciphertext FROM journals WHERE id=?', id).ciphertext, old);
  assert.equal(f.model.get('SELECT created FROM personal_notes WHERE id=?', id).created, legacy.created);
  assert.match(await (await client.request('/notes')).text(), /Legacy title/);
  assert.equal(f.model.get('SELECT count(*) AS n FROM personal_notes').n, 1);
});

test('retired writing routes are gone and the compact primary navigation retains Weekly Summary', async t => {
  const f = await fixture(t);
  const client = f.client();
  await client.auth(password, password);
  const page = await (await client.request('/notes/new')).text();
  const navigation = page.match(/<nav aria-label="Main navigation">([\s\S]+?)<\/nav>/)[1];
  assert.match(navigation, /Today<\/a>[\s\S]*?History<\/a>[\s\S]*?Monthly<\/a>[\s\S]*?Notes<\/a>[\s\S]*?Settings<\/a>/);
  assert.match(navigation, /href="\/notes" aria-current="true"/);
  assert.doesNotMatch(navigation, /Reflections|\/weekly|\/journal/);
  assert.equal((await client.request('/weekly')).status, 404);
  assert.equal((await client.request('/journal')).status, 404);
  assert.equal((await client.request('/api/weekly/2026-11-23', { method: 'PUT', json: {} })).status, 404);
  assert.equal((await client.request('/statistics')).status, 200);
  assert.match(await (await client.request('/history')).text(), /Weekly summary/);
  const style = await (await client.request('/assets/steady.css')).text();
  assert.match(style, /@media \(max-width:780px\)[\s\S]*?\.site-header nav > a/);
});

test('empty setup reset makes a valid backup and allows newly confirmed credentials and first login', async t => {
  const original = await fixture(t);
  const folder = original.folder;
  const file = join(folder, 'steady.sqlite');
  const originalClient = original.client();
  assert.equal((await originalClient.auth(password, password)).status, 303);
  await originalClient.request('/lock', { method: 'POST' });
  assert.equal((await originalClient.auth('incorrect')).status, 401);
  await original.stop();

  const backup = new DatabaseSync(await resetEmptySetup(file), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.ok(backup.prepare("SELECT 1 FROM metadata WHERE key='credential'").get());
    assert.ok(backup.prepare("SELECT 1 FROM metadata WHERE key='passwordAttempts'").get());
    assert.equal(backup.prepare('SELECT count(*) AS n FROM habits').get().n, 4);
  } finally { backup.close(); }

  const fresh = await fixture(t, folder);
  try {
    const client = fresh.client();
    assert.equal(fresh.model.meta('credential'), null);
    assert.equal(fresh.model.meta('passwordAttempts'), null);
    assert.equal(fresh.model.get('SELECT count(*) AS n FROM sessions').n, 0);
    const page = await (await client.request('/auth')).text();
    assert.match(page, /Set up Steady/);
    assert.match(page, /Confirm password/);
    assert.match(page, /data-password-toggle aria-controls="master-password"/);
    assert.match(page, /class="brand-mark brand-pendant"\s+src="\/assets\/images\/logo_jade_nav.png"/);
    assert.match(page, /data-password-toggle aria-controls="confirm-password"/);
    const mismatch = await client.auth(nextPassword, password);
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /The passwords do not match/);
    assert.equal(fresh.model.meta('passwordAttempts'), null);
    assert.equal((await client.auth(nextPassword, nextPassword)).status, 303);
    assert.deepEqual(fresh.model.meta('passwordAttempts'), { count: 0, until: 0 });
    assert.equal(fresh.model.daily(fresh.model.today()).total, 4);
    assert.equal((await client.request('/lock', { method: 'POST' })).status, 303);
    const login = await (await client.request('/auth')).text();
    assert.match(login, /data-password-toggle aria-controls="master-password"/);
    assert.match(login, /class="brand-mark brand-pendant"\s+src="\/assets\/images\/logo_jade_nav.png"/);
    assert.doesNotMatch(login, /data-password-toggle aria-controls="confirm-password"/);
    assert.doesNotMatch(login, /Confirm password/);
    assert.equal((await client.auth(nextPassword)).status, 303);
    assert.equal((await client.request('/')).status, 200);
    fresh.model.setCompletion(fresh.model.today(), fresh.model.habits()[0].id, true, fresh.model.today());
  } finally {
    await fresh.stop();
  }
  await assert.rejects(resetEmptySetup(file), /Reset refused/);
  const preserved = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(preserved.prepare('SELECT count(*) AS n FROM completions').get().n, 1); }
  finally { preserved.close(); }
});

