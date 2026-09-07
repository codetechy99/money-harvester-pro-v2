import app from "./app";
import { logger } from "./lib/logger";
import { startEngineScheduler, stopEngineScheduler } from "./lib/engine-scheduler";

const rawPort = process.env["PORT"] || "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const host = "0.0.0.0";

const server = app.listen(port, host, () => {
  logger.info({ port, host }, "Server listening on 0.0.0.0");
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
