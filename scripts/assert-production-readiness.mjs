#!/usr/bin/env node
import { assertProductionReadiness } from "../lib/production-readiness-enforcement.mjs";

try {
  const result = assertProductionReadiness(process.env);
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
