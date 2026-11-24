import session from 'express-session';
import { token } from '../services/security.js';
import { check } from '../models/steady.js';

const maxPasswordAttempts = 8;

class SQLiteStore extends session.Store {
  constructor(model) { super(); this.model = model; }
  get(id, done) {
    let data;
    try {
      const row = this.model.get('SELECT data FROM sessions WHERE id=? AND expires>?', id, this.model.now());
      data = row ? JSON.parse(row.data) : null;
    } catch (error) { return done(error); }
    done(null, data);
  }
  set(id, data, done) {
    try {
      this.model.run('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires',
        id, JSON.stringify(data), this.model.now() + 24 * 60 * 60 * 1000);
    } catch (error) { if (done) done(error); return; }
    if (done) done();
  }
  destroy(id, done) {
    try { this.model.run('DELETE FROM sessions WHERE id=?', id); }
    catch (error) { if (done) done(error); return; }
    if (done) done();
  }
  touch(id, data, done) {
    try { this.model.run('UPDATE sessions SET expires=? WHERE id=?', this.model.now() + 24 * 60 * 60 * 1000, id); }
    catch (error) { if (done) done(error); return; }
    if (done) done();
  }
}

const invoke = (session, method) => new Promise((resolve, reject) =>
  session[method](error => error ? reject(error) : resolve()));

export function sessionSecurity(model, secure) {
  const keys = new Map();
  const duration = () => (model.meta('settings')?.lock ?? 15) * 60000;
  function forget(id) {
    keys.get(id)?.key.fill(0);
    keys.delete(id);
  }
  function expire(id) {
    forget(id);
    model.run('DELETE FROM sessions WHERE id=?', id);
  }
  const timer = setInterval(() => {
    const idle = duration();
    for (const [id, entry] of keys) if (entry.activity + idle <= model.now()) expire(id);
    model.run('DELETE FROM sessions WHERE expires<=?', model.now());
  }, 1000);
  timer.unref();
  let secret = model.meta('sessionSecret');
  if (!secret) {
    secret = token();
    model.setMeta('sessionSecret', secret);
  }
  const cookie = { httpOnly: true, sameSite: 'strict', secure, path: '/' };
  const name = 'steady.sid';
  return {
    middleware: session({ name, secret, cookie, store: new SQLiteStore(model), resave: false, saveUninitialized: false }),
    close() {
      clearInterval(timer);
      for (const id of keys.keys()) forget(id);
    },
    lookup(req, extend = false) {
      const entry = req.session?.unlocked && keys.get(req.sessionID);
      if (!entry) return null;
      if (entry.activity + duration() <= model.now()) { expire(req.sessionID); return null; }
      if (extend) entry.activity = model.now();
      return entry.key;
    },
    revokeOthers(id) {
      for (const key of keys.keys()) if (key !== id) forget(key);
      model.run('DELETE FROM sessions WHERE id<>?', id);
    },
    async enter(req, key) {
      forget(req.sessionID);
      try {
        await invoke(req.session, 'regenerate');
        req.session.unlocked = true;
        req.session.csrf = token();
        await invoke(req.session, 'save');
        keys.set(req.sessionID, { key, activity: model.now() });
      } catch (error) {
        key.fill(0);
        throw error;
      }
    },
    async leave(req, res) {
      forget(req.sessionID);
      await invoke(req.session, 'destroy');
      res.clearCookie(name, cookie);
    }
  };
}

export function rateGate(model) {
  let busy = false;
  return async operation => {
    const now = model.now();
    const previous = model.meta('passwordAttempts');
    const attempt = previous?.until > now ? previous : { count: 0, until: now + 5 * 60 * 1000 };
    check(!busy, 'Another password check is in progress. Try again shortly.', 429);
    if (attempt.count >= maxPasswordAttempts) {
      const retryAfter = Math.ceil((attempt.until - now) / 1000);
      throw Object.assign(new Error('Too many password attempts.'), { public: true, status: 429, retryAfter });
    }
    busy = true;
    try {
      const result = await operation();
      model.setMeta('passwordAttempts', { count: 0, until: 0 });
      return result;
    } catch (error) {
      if (error.status === 401) model.setMeta('passwordAttempts', { ...attempt, count: attempt.count + 1 });
      throw error;
    } finally {
      busy = false;
    }
  };
}

export function cooldownSeconds(model) {
  const attempts = model.meta('passwordAttempts');
  return attempts?.count >= maxPasswordAttempts ? Math.max(0, Math.ceil((attempts.until - model.now()) / 1000)) : 0;
}

