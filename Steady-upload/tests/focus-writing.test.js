import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFocusWriting } from '../public/focus-writing.js';

test('focus writing keeps the same draft and exits with Escape', () => {
  const toggle = Object.assign(new EventTarget(), { setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; } });
  const textarea = { value: 'A draft\nwith a new paragraph.', focus() { this.focused = true; } };
  const classes = new Set();
  const document = Object.assign(new EventTarget(), {
    body: { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } },
    querySelector(selector) { return selector === '[data-focus-writing]' ? toggle : { querySelector: () => textarea }; }
  });
  bindFocusWriting(document);
  toggle.dispatchEvent(new Event('click'));
  assert.equal(textarea.focused, true);
  assert.ok(classes.has('focus-writing'));
  assert.equal(toggle['aria-pressed'], 'true');
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  assert.equal(document.dispatchEvent(escape), false);
  assert.ok(!classes.has('focus-writing'));
  assert.equal(toggle.focused, true);
  assert.equal(textarea.value, 'A draft\nwith a new paragraph.');
});

