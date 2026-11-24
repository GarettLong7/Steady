import test from 'node:test';
import assert from 'node:assert/strict';

test('the eye button toggles only its own field and preserves the value, focus, and selection', async t => {
  const form = new EventTarget();
  function field(label) {
    const attributes = new Map();
    const button = Object.assign(new EventTarget(), {
      hidden: true, dataset: { passwordLabel: label },
      setAttribute(name, value) { attributes.set(name, value); },
      toggleAttribute(name, enabled) { if (enabled) attributes.set(name, ''); else attributes.delete(name); }
    });
    const input = {
      form, type: 'password', value: '  synthetic sample  ', selectionStart: 2, selectionEnd: 7,
      selectionDirection: 'forward',
      focus() { this.focused = true; },
      setSelectionRange(...selection) { this.selection = selection; }
    };
    return { button, input, attributes, querySelector: selector => selector === 'input' ? input : button };
  }
  const master = field('master password');
  const confirmation = field('confirm password');
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-password-field]' ? [master, confirmation] : []
  };
  t.after(() => { delete globalThis.document; });
  await import('../public/steady.js');

  assert.equal(master.button.hidden, false);
  master.button.dispatchEvent(new Event('click'));
  assert.equal(master.input.type, 'text');
  assert.equal(confirmation.input.type, 'password');
  assert.equal(master.input.value, '  synthetic sample  ');
  assert.equal(master.input.focused, true);
  assert.deepEqual(master.input.selection, [2, 7, 'forward']);
  assert.equal(master.attributes.get('aria-label'), 'Hide master password');
  assert.ok(master.attributes.has('data-password-visible'));

  master.button.dispatchEvent(new Event('click'));
  assert.equal(master.input.type, 'password');
  assert.equal(master.input.value, '  synthetic sample  ');
  assert.equal(master.attributes.get('aria-label'), 'Show master password');
  assert.ok(!master.attributes.has('data-password-visible'));

  confirmation.button.dispatchEvent(new Event('click'));
  form.dispatchEvent(new Event('reset'));
  assert.equal(confirmation.input.type, 'password');
  assert.ok(!confirmation.attributes.has('data-password-visible'));
});

