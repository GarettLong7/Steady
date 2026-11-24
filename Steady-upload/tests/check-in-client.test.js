import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

async function checkRetry(t, mode) {
  const feedback = { classList: { toggle() {} } };
  const retry = new EventTarget();
  retry.hidden = true;
  const editor = Object.assign(new EventTarget(), {
    dataset: { day: '2026-11-23', generation: 'sample', version: '1',
      endpoint: mode === 'note' ? '/api/notes/' + 'a'.repeat(32) : '/api/daily/2026-11-23' },
    fields: [['title', 'Daily reflection'], ['body', 'Text kept in the editor']],
    querySelector: selector => ({ '[data-status]': feedback, '[data-retry]': retry })[selector] ?? null
  });
  const link = { href: 'http://127.0.0.1:3001/?day=2026-11-24', origin: 'http://127.0.0.1:3001', hash: '' };
  const document = Object.assign(new EventTarget(), {
    querySelector: selector => ({ '[data-today]': {}, '[data-editor]': editor })[selector] ?? null,
    querySelectorAll: () => [],
    closest: () => link
  });
  const window = Object.assign(new EventTarget(), { setInterval() {} });
  const navigations = [];
  const requested = [];
  let networkAvailable = false;
  const globals = {
    document, window, location: { origin: link.origin, assign: href => navigations.push(href) },
    FormData: class { constructor(form) { return form.fields; } }
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = globalThis[name];
    globalThis[name] = value;
    t.after(() => {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    });
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push({ url, ...JSON.parse(options.body) });
    if (!networkAvailable) throw new Error('Offline');
    return new Response(JSON.stringify({ version: 2 }), { status: 200 });
  });
  await import('../public/steady.js?mode=' + mode);
  const clickDate = () => document.dispatchEvent(Object.assign(new Event('click', { cancelable: true }), { button: 0 }));
  editor.dispatchEvent(new Event('input'));
  assert.equal(clickDate(), false);
  await setImmediate();
  assert.match(feedback.textContent, /Couldn't save/);
  assert.equal(retry.hidden, false);
  assert.deepEqual(navigations, []);
  assert.equal(window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);
  networkAvailable = true;
  retry.dispatchEvent(new Event('click'));
  await setImmediate();
  assert.equal(feedback.textContent, 'Saved');
  assert.equal(retry.hidden, true);
  assert.deepEqual(requested.map(({ url, body }) => [url, body]),
    Array(2).fill([editor.dataset.endpoint, 'Text kept in the editor']));
  assert.equal(clickDate(), true);
  assert.equal(window.dispatchEvent(new Event('beforeunload', { cancelable: true })), true);
}

test('failed daily text stays on the original date and can be retried', t => checkRetry(t, 'free'));
test('failed note text is preserved and can be retried', t => checkRetry(t, 'note'));

