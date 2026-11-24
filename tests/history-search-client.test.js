import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

class Element extends EventTarget {
  children = [];
  dataset = {};
  value = '';
  selectors = {};
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  querySelector(selector) { return this.selectors[selector] ?? null; }
  focus() { this.focused = true; }
}

test('History boot and unified search interactions', async t => {
  const field = new Element();
  const date = new Element();
  const button = Object.assign(new Element(), { disabled: true });
  const clearButton = new Element();
  const form = Object.assign(new Element(), {
    selectors: { '[data-search-term]': field, 'button[type="submit"]': button, '[data-search-clear]': clearButton },
    elements: { day: date }
  });
  const calendarCell = new Element();
  const feedback = new Element();
  const list = new Element();
  const retry = new Element();
  const results = Object.assign(new Element(), { hidden: true, selectors: {
    '[data-search-status]': feedback, '[data-search-list]': list, '[data-search-retry]': retry
  } });
  const sessionStatus = Object.assign(new Element(), { hidden: true });
  const document = Object.assign(new Element(), {
    selectors: {
      '[data-search]': form, '[data-search-results]': results, '.history-search': new Element(),
      '#session-status': sessionStatus, 'meta[name="csrf-token"]': { content: 'test-csrf' }
    },
    querySelectorAll: selector => selector === '[data-mood]' ? [calendarCell] : [],
    createElement: tag => Object.assign(new Element(), { tag })
  });
  const redirects = [];
  const globals = { document, window: new Element(), location: { replace: path => redirects.push(path) } };
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const name of Object.keys(globals)) delete globalThis[name];
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const pending = Promise.withResolvers();
    requests.push({ url, options, ...pending });
    return pending.promise;
  });
  await import('../public/steady.js');
  assert.equal(button.disabled, false);
  assert.equal(results.hidden, true);
  const key = (target, modifiers = {}) => target.dispatchEvent(Object.assign(
    new Event('keydown', { cancelable: true }), { key: '/', ...modifiers }
  ));
  assert.equal(key(document), false);
  assert.equal(field.focused, true);
  assert.equal(key(document, { ctrlKey: true }), true);
  const input = value => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const submit = submitter => form.dispatchEvent(Object.assign(new Event('submit', { cancelable: true }), { submitter }));
  const reply = async (request, entries, limited = false) => {
    request.resolve(Response.json({ entries, limited }));
    await setImmediate();
  };
  const daily = { kind: 'daily', date: '2026-11-23', href: '/?day=2026-11-23', preview: '<img src=x>' };
  const monthly = { kind: 'monthly', date: '2026-11', href: '/monthly?month=2026-11' };
  const note = { kind: 'note', date: '2025-11-23', href: '/notes/' + 'a'.repeat(32), title: '<script>title</script>' };

  input('2');
  t.mock.timers.tick(150);
  input(' 23 ');
  t.mock.timers.tick(299);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1);
  assert.equal(feedback.textContent, 'Searching\u2026');
  assert.equal(submit(button), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/search');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.get('X-CSRF-Token'), 'test-csrf');
  assert.deepEqual(JSON.parse(requests[0].options.body), { q: '23', day: '', type: '' });
  await reply(requests[0], [daily, monthly, note, ...['javascript:alert(1)', '//other.example/', '/settings'].map(href => ({ ...daily, href }))]);
  assert.equal(results.hidden, false);
  assert.equal(feedback.textContent, '3 results');
  assert.deepEqual(list.children.map(link => link.href), [daily.href, monthly.href, note.href]);
  assert.deepEqual(list.children.map(link => link.children[0].textContent), [
    'Daily Reflection \u00b7 23 November 2026', 'Monthly Reflection \u00b7 November 2026', 'Personal Note \u00b7 23 November 2025'
  ]);
  assert.equal(list.children[0].children[1].textContent, '<img src=x>');
  assert.equal(list.children[2].children[1].textContent, '<script>title</script>');
  assert.equal(submit(), false);
  assert.equal(requests.length, 1);

  input('old');
  t.mock.timers.tick(300);
  input('new');
  assert.equal(requests[1].options.signal.aborted, true);
  assert.equal(submit(button), false);
  await reply(requests[2], [note]);
  await reply(requests[1], [daily]);
  assert.deepEqual(list.children.map(link => link.href), [note.href]);

  input('another');
  t.mock.timers.tick(300);
  input('');
  assert.equal(requests[3].options.signal.aborted, true);
  await reply(requests[3], [daily]);
  assert.equal(results.hidden, true);
  assert.equal(list.children.length, 0);

  date.value = '2026-11-23';
  date.dispatchEvent(new Event('change'));
  assert.deepEqual(JSON.parse(requests[4].options.body), { q: '', day: '2026-11-23', type: '' });
  requests[4].reject(new Error('offline'));
  await setImmediate();
  assert.equal(feedback.textContent, "Search couldn't be completed. Please try again.");
  assert.equal(retry.hidden, false);
  retry.dispatchEvent(new Event('click'));
  await reply(requests[5], []);
  assert.equal(feedback.textContent, 'No matching entries found.');
  assert.equal(retry.hidden, true);
  clearButton.dispatchEvent(new Event('click'));
  assert.equal(results.hidden, true);
  assert.equal(date.value, '');
  assert.equal(field.value, '');
  assert.equal(field.focused, true);
  input('limited');
  assert.equal(submit(button), false);
  await reply(requests[6], Array.from({ length: 75 }, () => daily), true);
  assert.equal(list.children.at(-1).textContent, 'Showing the first 75 matches. Try a more specific search.');

  form.dataset.type = 'daily';
  input('not found');
  assert.equal(submit(), false);
  assert.equal(JSON.parse(requests[7].options.body).type, 'daily');
  await reply(requests[7], []);
  assert.equal(feedback.textContent, 'No reflections match your search');

  input('expired');
  assert.equal(submit(), false);
  requests[8].resolve(Response.json({ locked: true }, { status: 401 }));
  await setImmediate();
  assert.deepEqual(redirects, ['/auth']);
  assert.equal(results.hidden, true);
  assert.equal(list.children.length, 0);
});
