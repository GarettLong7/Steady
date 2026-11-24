export function draftSaver({ read, write, report, delay = 850, schedule = setTimeout, cancel = clearTimeout }) {
  let revision = 0;
  let saved = 0;
  let timer;
  let active;
  let blocked = false;
  let failed = false;
  let pending;
  async function flush() {
    cancel(timer);
    if (active) return (await active) && (revision === saved || flush());
    if (revision === saved) return true;
    if (blocked) return false;
    failed = false;
    active = (async () => {
      report('Saving…');
      try {
        pending ??= { target: revision, value: read() };
        await write(pending.value);
        saved = pending.target;
        pending = undefined;
        report(revision === saved ? 'Saved' : 'Unsaved changes');
        return true;
      } catch (error) {
        blocked = error.status === 409;
        if (error.status >= 400 && error.status < 500) pending = undefined;
        failed = true;
        cancel(timer);
        report("Couldn't save. " + error.message, true, error.status);
        return false;
      }
    })();
    const result = await active;
    active = undefined;
    return result && (revision === saved || flush());
  }
  return {
    change() {
      revision++;
      if (failed) return;
      report('Unsaved changes');
      cancel(timer);
      timer = schedule(flush, delay);
    },
    flush,
    get dirty() { return revision !== saved; }
  };
}

