import { buildApp } from './src/app.js';
import { createRepository } from './src/repository.js';

const repository = await createRepository();
const app = buildApp(repository);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port });
