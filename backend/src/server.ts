import { buildApp } from "./app.js";
import { createRepository } from "./repository.js";

const repository=await createRepository();
const app=buildApp(repository);
const port=Number(process.env.PORT??4000);

await app.listen({port,host:"0.0.0.0"});

const shutdown=async()=>{await app.close();process.exit(0);};
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
