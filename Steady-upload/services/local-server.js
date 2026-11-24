import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';

export const DEFAULT_PORT = 3001;

export function listen(app, { port = DEFAULT_PORT, tls } = {}) {
  const server = tls ? httpsServer(tls, app) : httpServer(app);
  server.listen(port, '127.0.0.1');
  return server;
}

