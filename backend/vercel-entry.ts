import { buildApp } from './src/app.js';
import { createRepository } from './src/repository.js';

const app = buildApp(await createRepository());

export default app;
