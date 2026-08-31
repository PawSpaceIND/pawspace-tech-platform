import { buildApp } from './src/app.js';
import { createRepositoryFromEnv } from './src/repository.js';

const repository = await createRepositoryFromEnv();
const app = await buildApp({ repository });

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

await app.listen({ port, host });
