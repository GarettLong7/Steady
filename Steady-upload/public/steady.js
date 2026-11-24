import { draftSaver } from './draft.js';
import { bindFocusWriting } from './focus-writing.js';
import { bindWritingSearch } from './writing-search.js';

bindFocusWriting(document);

for (const field of document.querySelectorAll('[data-password-field]')) {
  const input = field.querySelector('input');
  const button = field.querySelector('[data-password-toggle]');
  const setVisible = visible => {
    input.type = visible ? 'text' : 'password';
    button.toggleAttribute('data-password-visible', visible);
    button.setAttribute('aria-label', (visible ? 'Hide ' : 'Show ') + button.dataset.passwordLabel);
  };
  button.hidden = false;
  button.addEventListener('click', () => {
    const { selectionStart, selectionEnd, selectionDirection } = input;
    setVisible(input.type === 'password');
    input.focus({ preventScroll: true });
    if (selectionStart !== null) input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  });
  input.form.addEventListener('reset', () => setVisible(false));
}

const auth = document.querySelector('[data-auth]');
if (auth) {
  const { password, confirmation } = auth.elements;
  if (confirmation) {
    const warning = document.getElementById('password-mismatch');
    const compare = () => {
      const mismatch = confirmation.value !== '' && password.value !== confirmation.value;
      warning.hidden = !mismatch;
      confirmation.setAttribute('aria-invalid', String(mismatch));
      return mismatch;
    };
    auth.addEventListener('input', compare);
    auth.addEventListener('submit', event => {
      if (compare()) {
        event.preventDefault();
        confirmation.focus();
      }
    });
  }
  const countdown = document.querySelector('[data-cooldown]');
  if (countdown) {
    const deadline = Date.now() + Number(countdown.dataset.cooldown) * 1000;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      countdown.textContent = remaining + (remaining === 1 ? ' second' : ' seconds');
      if (remaining === 0) {
        clearInterval(timer);
        countdown.closest('[role="alert"]').hidden = true;
        document.querySelector('[data-cooldown-finished]').hidden = false;
      }
    }, 250);
  }
}

const csrfNode = document.querySelector('meta[name="csrf-token"]');
const page = document.querySelector('[data-today]');
const status = (element, message, failed = false) => {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('failed', failed);
};

let draft;
let moodDraft;
let navigating = false;
let refreshJournalDate;
const sessionStatus = document.querySelector('#session-status');
const hasUnsaved = () => draft?.dirty || moodDraft?.dirty;
async function saveBeforeLeaving() {
  while (hasUnsaved()) {
    if (draft?.dirty && !(await draft.flush())) return false;
    if (moodDraft?.dirty && !(await moodDraft.flush())) return false;
  }
  return true;
}

function explainLock() {
  clearSearch?.();
  if (!sessionStatus || !sessionStatus.hidden) return;
  if (!hasUnsaved()) {
    location.replace('/auth');
    return;
  }
  sessionStatus.hidden = false;
  sessionStatus.textContent = 'Steady locked while you had unsaved changes. Keep this tab open. ';
  const link = document.createElement('a');
  link.href = '/auth';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Unlock in another tab';
  sessionStatus.append(link, ', then return here and select Retry.');
}

async function request(url, options = {}, retry = true) {
  const headers = new Headers(options.headers);
  if (csrfNode && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrfNode.content);
  let response;
  try {
    response = await fetch(url, { ...options, headers, cache: 'no-store' });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('The server could not be reached. Check that Steady is running and try again.');
  }
  if (response.status === 403 && retry && csrfNode) {
    const session = await request('/api/session', { signal: options.signal }, false);
    const { csrf } = await session.json();
    csrfNode.content = csrf;
    const lockToken = document.querySelector('.lock-form [name="_csrf"]');
    if (lockToken) lockToken.value = csrf;
    return request(url, options, false);
  }
  if (!response.ok) {
    const message = await response.json().catch(() => ({}));
    if (response.status === 401 && message.locked) explainLock();
    throw Object.assign(new Error(message.error || 'The request failed. Try again.'), { status: response.status });
  }
  if (url !== '/api/session') {
    if (sessionStatus) sessionStatus.hidden = true;
  }
  return response;
}

function json(url, method, body, signal) {
  return request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}

if (page) {
  let pulseAt = Date.now();
  let pulsing = false;
  const activity = async () => {
    if (pulsing || Date.now() - pulseAt < 15000) return;
    pulseAt = Date.now();
    pulsing = true;
    try { await json('/api/activity', 'POST', {}); } catch { /* The next request reports errors. */ }
    finally { pulsing = false; }
  };
  document.addEventListener('pointerdown', activity);
  document.addEventListener('keydown', activity);
  const checkLock = async () => {
    try {
      const response = await request('/api/session');
      const { today } = await response.json();
      refreshJournalDate?.(today);
    } catch { /* A locked session is handled by request. */ }
  };
  window.setInterval(checkLock, 5000);
  window.addEventListener('focus', checkLock);
  window.addEventListener('pageshow', event => {
    if (event.persisted) checkLock();
  });
}

function updateSelectedDay(changes) {
  const cell = document.querySelector('[data-selected-day]');
  if (!cell) return;
  Object.assign(cell.dataset, changes);
  const { total, done, mood, journal, extra, dayLabel } = cell.dataset;
  const state = !Number(total) ? (extra === 'true' ? 'optional-activity' : 'unscheduled') :
    done === total ? 'full' : Number(done) ? 'partial' :
    mood === 'true' || journal === 'true' || extra === 'true' ? 'incomplete' : 'unrecorded';
  const labels = { full: 'All completed', partial: 'Some completed', incomplete: 'None completed', unrecorded: 'No recorded activity',
    unscheduled: 'No scheduled habits', 'optional-activity': 'Optional activity completed' };
  cell.classList.remove(...Object.keys(labels));
  cell.classList.add(state);
  cell.setAttribute('aria-label', [dayLabel, labels[state], ...(journal === 'true' ? ['journal entry'] : []), 'selected'].join(', '));
}

for (const tracker of document.querySelectorAll('[data-tracker]')) {
  const checks = [...tracker.querySelectorAll('[data-habit]')];
  for (const checkbox of checks) checkbox.addEventListener('change', async () => {
    const previous = !checkbox.checked;
    for (const item of checks) item.disabled = true;
    const feedback = tracker.querySelector('[data-status]');
    status(feedback, 'Saving');
    try {
      const response = await json('/api/completions', 'PUT', {
        day: tracker.dataset.day, habit: Number(checkbox.dataset.habit), completed: checkbox.checked
      });
      const daily = await response.json();
      if (daily.total) tracker.querySelector('[data-count]').textContent = daily.done + ' of ' + daily.total + ' completed';
      tracker.querySelector('[data-percent]').textContent = daily.percentage + '%';
      tracker.querySelector('progress').value = daily.percentage;
      const completeNote = tracker.querySelector('[data-complete-note]');
      if (completeNote) completeNote.hidden = !daily.total || daily.done !== daily.total;
      const streak = document.querySelector('[data-streak]');
      if (streak) {
        streak.textContent = daily.streak;
        streak.nextElementSibling.textContent = daily.streak === 1 ? 'day' : 'days';
      }
      for (const habit of daily.optional ?? []) {
        const count = tracker.querySelector('[data-week-progress="' + habit.habit + '"]');
        if (!count) continue;
        count.textContent = habit.weekly.completed + ' / ' + habit.weekly.goal + ' days this week';
        const meter = tracker.querySelector('[data-week-meter="' + habit.habit + '"]');
        meter.max = habit.weekly.goal;
        meter.value = Math.min(habit.weekly.completed, habit.weekly.goal);
      }
      updateSelectedDay({ total: daily.total, done: daily.done, extra: Boolean(daily.extraDone) });
      status(feedback, 'Saved');
    } catch (error) {
      checkbox.checked = previous;
      status(feedback, 'Save failed. ' + error.message, true);
    } finally {
      for (const item of checks) item.disabled = false;
    }
  });
}

for (const form of document.querySelectorAll('form[data-mood]')) {
  const feedback = form.querySelector('[data-status]');
  const retry = form.querySelector('[data-retry]');
  moodDraft = draftSaver({
    delay: 0,
    read: () => form.elements.mood.value,
    async write(mood) {
      await json('/api/mood', 'PUT', { day: form.dataset.day, mood });
      updateSelectedDay({ mood: Boolean(mood) });
    },
    report(message, failed) {
      status(feedback, message, failed);
      retry.hidden = !failed;
    }
  });
  form.addEventListener('change', () => moodDraft.change());
  retry.addEventListener('click', () => moodDraft.flush());
}

const editor = document.querySelector('[data-editor]');
if (editor) {
  const feedback = editor.querySelector('[data-status]');
  const deleteButton = editor.querySelector('[data-delete]');
  const reloadButton = editor.querySelector('[data-reload-entry]');
  const retry = editor.querySelector('[data-retry]');
  const endpoint = editor.dataset.endpoint;
  let version = Number(editor.dataset.version);
  const followsToday = editor.dataset.followsToday === 'true';
  const rollover = document.querySelector('[data-journal-rollover]');
  refreshJournalDate = today => {
    if (!followsToday || today === editor.dataset.day) return;
    const savingHabits = document.querySelector('[data-tracker] input:disabled');
    if (!version && !hasUnsaved() && !savingHabits) location.reload();
    else rollover.hidden = false;
  };
  const metadata = () => ({ generation: editor.dataset.generation, version });
  draft = draftSaver({
    read: () => ({ ...Object.fromEntries(new FormData(editor)), ...metadata() }),
    async write(value) {
      const response = await json(endpoint, 'PUT', value);
      version = (await response.json()).version;
      if (deleteButton) deleteButton.hidden = false;
      if (editor.dataset.savedUrl && location.pathname !== editor.dataset.savedUrl) {
        history.replaceState(null, '', editor.dataset.savedUrl);
      }
    },
    report: (message, failed, code) => {
      status(feedback, message, failed);
      retry.hidden = !failed || code === 409;
      if (reloadButton) reloadButton.hidden = code !== 409;
    }
  });
  editor.addEventListener('input', () => draft.change());
  editor.addEventListener('submit', event => { event.preventDefault(); draft.flush(); });
  retry.addEventListener('click', () => draft.flush());
  editor.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter' && !event.isComposing && !event.repeat) {
      event.preventDefault();
      draft.flush();
    }
  });
  reloadButton?.addEventListener('click', () => {
    if (!window.confirm('Discard the unsaved text in this tab and reload the entry?')) return;
    navigating = true;
    const url = new URL(location.href);
    if (editor.dataset.day) url.searchParams.set(editor.dataset.periodParam ?? 'day', editor.dataset.day);
    location.replace(url);
  });
  deleteButton?.addEventListener('click', async () => {
    if (!window.confirm('Permanently delete this note?')) return;
    deleteButton.disabled = true;
    try {
      if (!(await saveBeforeLeaving())) return;
      await json(endpoint, 'DELETE', { ...metadata(), confirm: true });
      navigating = true;
      location.assign(editor.dataset.deleteReturn);
    } catch (error) {
      status(feedback, error.message, true);
    } finally {
      deleteButton.disabled = false;
    }
  });
  const textarea = editor.querySelector('textarea[name="body"]');
  if (textarea && !CSS.supports('field-sizing', 'content')) {
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = (textarea.scrollHeight + 2) + 'px';
    };
    textarea.addEventListener('input', resize);
    window.addEventListener('resize', resize);
    resize();
  }
}

document.querySelector('[data-month-select]')?.addEventListener('submit', async event => {
  if (!hasUnsaved()) return;
  event.preventDefault();
  if (await saveBeforeLeaving()) {
    navigating = true;
    location.assign('/monthly?' + new URLSearchParams(new FormData(event.target)));
  }
});

if (page) window.addEventListener('beforeunload', event => {
  if (hasUnsaved() && !navigating) { event.preventDefault(); event.returnValue = ''; }
});
if (page) document.addEventListener('click', async event => {
  const link = event.target.closest?.('a[href]');
  if (!hasUnsaved() || !link || link.target || event.defaultPrevented || event.button !== 0 ||
      event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.origin !== location.origin) return;
  if (link.hash && link.pathname === location.pathname && link.search === location.search) return;
  event.preventDefault();
  if (await saveBeforeLeaving()) { navigating = true; location.assign(link.href); }
});

document.querySelector('.lock-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!(await saveBeforeLeaving())) return;
  try {
    await json('/api/lock', 'POST', {});
    clearSearch?.();
    navigating = true;
    location.replace('/auth');
  } catch (error) {
    sessionStatus.hidden = false;
    sessionStatus.textContent = error.message;
  }
});

const clearSearch = bindWritingSearch(document, {
  onHistory: document.querySelector('.history-search') !== null,
  request: (body, signal) => json('/api/search', 'POST', body, signal)
});
if (clearSearch) window.addEventListener('pagehide', clearSearch);

for (const schedule of document.querySelectorAll('[data-habit-schedule]')) {
  const update = () => {
    for (const fields of schedule.form.querySelectorAll('[data-schedule-option]')) {
      fields.hidden = fields.dataset.scheduleOption !== schedule.value;
      for (const input of fields.querySelectorAll('input')) input.disabled = fields.hidden;
    }
  };
  schedule.addEventListener('change', update);
  update();
}
document.querySelector('[data-open-backup]')?.addEventListener('click', () => {
  document.getElementById('encrypted-backup').open = true;
});

for (const form of document.querySelectorAll('[data-action]')) form.addEventListener('submit', async event => {
  event.preventDefault();
  if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
  const feedback = form.querySelector('[data-status]');
  const data = Object.fromEntries(new FormData(form, event.submitter));
  const method = form.dataset.method || 'POST';
  if (form.dataset.id) data.id = Number(form.dataset.id);
  if (form.elements.active) data.active = form.elements.active.checked;
  if (data.kind === 'weekdays') {
    data.weekdays = [...form.querySelectorAll('[name="weekday"]:checked')].reduce((mask, input) => mask | Number(input.value), 0);
  }
  if (form.dataset.confirm) data.confirm = true;
  const buttons = [...form.querySelectorAll('button:not(:disabled)')];
  for (const button of buttons) button.disabled = true;
  status(feedback, 'Working…');
  try {
    let response;
    if (data.file instanceof File) {
      if (data.file.size > 64 * 1024 * 1024) throw new Error('This backup exceeds the 64 MiB restore limit.');
      data.file = await data.file.text();
      response = await request(form.dataset.action, { method, headers: { 'Content-Type': 'application/octet-stream' }, body: JSON.stringify(data) });
    } else {
      response = await json(form.dataset.action, method, data);
    }
    if (form.dataset.download) {
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = form.dataset.download;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if ('reset' in form.dataset) form.reset();
    status(feedback, form.dataset.action === '/api/restore' ? 'Backup restored. Reloading settings…' : 'Saved');
    if ('reload' in form.dataset || form.dataset.action === '/api/restore') location.reload();
  } catch (error) {
    status(feedback, error.message, true);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
});

