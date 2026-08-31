import { buildApp } from './src/app.js';
import { createRepository } from './src/repository.js';

console.error('[uat-bootstrap] start');

try {
  const repository = await createRepository();
  console.error('[uat-bootstrap] repository-ready', process.env.DATABASE_DRIVER === 'mongodb' ? 'mongodb' : 'memory');

  const app = buildApp(repository);
  console.error('[uat-bootstrap] app-built');

  const port = Number(process.env.PORT ?? 3000);
  console.error('[uat-bootstrap] listen-call', port);

  void app.listen({ port })
    .then(() => console.error('[uat-bootstrap] listen-resolved'))
    .catch((error) => console.error('[uat-bootstrap] listen-rejected', error));

  console.error('[uat-bootstrap] listen-returned');
} catch (error) {
  console.error('[uat-bootstrap] fatal', error);
  throw error;
}
