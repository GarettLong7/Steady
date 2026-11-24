const dayLabel = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const kinds = { daily: 'Daily Reflection', monthly: 'Monthly Reflection', note: 'Personal Note' };

function resultLink(entry) {
  const { kind, date, href } = entry;
  if (kind === 'monthly') return /^\d{4}-\d{2}$/.test(date) && href === '/monthly?month=' + date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (kind === 'daily') return href === '/?day=' + date;
  return kind === 'note' && typeof href === 'string' && /^\/notes\/[a-f0-9]{32}$/.test(href);
}

export function bindWritingSearch(document, { onHistory, request }) {
  const form = document.querySelector('[data-search]');
  if (!form) return;
  const term = form.querySelector('[data-search-term]');
  const date = form.elements.day;
  const submit = form.querySelector('button[type="submit"]');
  const clearButton = form.querySelector('[data-search-clear]');
  const searchAll = form.querySelector('[data-search-all]');
  const results = document.querySelector('[data-search-results]');
  const feedback = results.querySelector('[data-search-status]');
  const list = results.querySelector('[data-search-list]');
  const retry = results.querySelector('[data-search-retry]');
  let timer;
  let active;
  let displayedKey;

  function clear() {
    clearTimeout(timer);
    active?.controller.abort();
    active = undefined;
    displayedKey = undefined;
    results.hidden = true;
    list.replaceChildren();
    feedback.textContent = '';
    retry.hidden = true;
  }

  function render(entries, limited, type) {
    feedback.textContent = entries.length
      ? entries.length + (entries.length === 1 ? ' result' : ' results')
      : type === 'daily' ? 'No reflections match your search' : 'No matching entries found.';
    for (const entry of entries) {
      const link = document.createElement('a');
      link.className = 'writing-result';
      link.href = entry.href;
      const label = document.createElement('span');
      label.className = 'muted small';
      const monthly = entry.kind === 'monthly';
      const date = new Date((monthly ? entry.date + '-01' : entry.date) + 'T00:00:00Z');
      label.textContent = kinds[entry.kind] + ' \u00b7 ' + (monthly ? monthLabel : dayLabel).format(date);
      link.append(label);
      if (entry.title || entry.kind === 'note') {
        const title = document.createElement('strong');
        title.textContent = entry.title || 'Untitled note';
        link.append(title);
      }
      if (entry.preview) {
        const preview = document.createElement('span');
        preview.textContent = entry.preview;
        link.append(preview);
      }
      list.append(link);
    }
    if (limited) {
      const hint = document.createElement('p');
      hint.className = 'muted small search-feedback';
      hint.textContent = entries.length === 75
        ? 'Showing the first 75 matches. Try a more specific search.'
        : 'Search reached its scan limit. Try a more specific search.';
      list.append(hint);
    }
  }

  async function find(body, key) {
    const controller = new AbortController();
    const current = { controller, key };
    active = current;
    results.hidden = false;
    feedback.textContent = 'Searching\u2026';
    try {
      const response = await request(body, controller.signal);
      const { entries, limited } = await response.json();
      if (active !== current) return;
      render(entries.filter(resultLink), limited, body.type);
      displayedKey = key;
    } catch (error) {
      if (active !== current) return;
      if (error.status === 401) {
        clear();
        return;
      }
      list.replaceChildren();
      feedback.textContent = "Search couldn't be completed. Please try again.";
      retry.hidden = false;
    } finally {
      if (active === current) active = undefined;
    }
  }

  function queue({ immediate = false, requireTerm = false } = {}) {
    const body = { q: term.value.trim(), day: date.value, type: searchAll?.checked ? '' : form.dataset.type ?? '' };
    if (!body.q && (requireTerm || !body.day)) {
      clear();
      return;
    }
    const key = JSON.stringify(body);
    if (active?.key === key || displayedKey === key) return;
    clear();
    if (immediate) void find(body, key);
    else timer = setTimeout(() => find(body, key), 300);
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    queue({ immediate: true });
  });
  term.addEventListener('input', () => queue({ requireTerm: true }));
  date.addEventListener('change', () => queue({ immediate: true }));
  searchAll?.addEventListener('change', () => queue({ immediate: true }));
  if (clearButton) {
    clearButton.disabled = false;
    clearButton.addEventListener('click', () => {
      term.value = '';
      date.value = '';
      clear();
      term.focus();
    });
  }
  retry.addEventListener('click', () => queue({ immediate: true }));
  if (onHistory) document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.defaultPrevented || event.isComposing || event.ctrlKey ||
        event.altKey || event.metaKey ||
        event.target.closest?.('input,textarea,select,[contenteditable],[role="textbox"]')) return;
    event.preventDefault();
    term.focus();
  });
  submit.disabled = false;
  return clear;
}
