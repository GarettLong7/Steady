export function bindFocusWriting(document) {
  const toggle = document.querySelector('[data-focus-writing]');
  if (!toggle) return;
  const editor = document.querySelector('#journal-editor');
  let active = false;
  function setFocus(enabled) {
    active = enabled;
    document.body.classList.toggle('focus-writing', active);
    toggle.setAttribute('aria-pressed', String(active));
    toggle.textContent = active ? 'Exit focus mode' : 'Focus Writing';
    if (active) editor.querySelector('textarea').focus();
    else toggle.focus();
  }
  toggle.addEventListener('click', () => setFocus(!active));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !event.isComposing && !event.defaultPrevented) {
      event.preventDefault();
      setFocus(false);
    }
  });
}

