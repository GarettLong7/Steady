import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { listen } from '../services/local-server.js';

test('server listens on IPv4 loopback and accepts a local request', async t => {
  const server = listen((req, res) => res.end('Steady'), { port: 0 });
  t.after(() => {
    if (server.listening) return new Promise(resolve => server.close(resolve));
  });
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  assert.equal(await response.text(), 'Steady');
});

