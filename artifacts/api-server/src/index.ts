import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchema } from "./lib/migrate";
import { startEngineScheduler, stopEngineScheduler } from "./lib/engine-scheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, "0.0.0.0", async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  try {
    await ensureSchema();
  } catch (schemaError) {
    logger.error({ err: schemaError }, "Database schema bootstrap failed");
    process.exit(1);
  }

  logger.info({ port }, "Server listening on 0.0.0.0");
  startEngineScheduler();
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down API server");
  stopEngineScheduler();
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      logger.error({ error }, "API server shutdown failed");
      process.exitCode = 1;
      return;
    }
    logger.info("API server stopped");
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
