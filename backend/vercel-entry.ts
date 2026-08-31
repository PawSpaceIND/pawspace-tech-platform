import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './src/app.js';
import { createRepository } from './src/repository.js';

const app = buildApp(await createRepository());
await app.ready();

export default function handler(request: IncomingMessage, response: ServerResponse) {
  app.server.emit('request', request, response);
}
