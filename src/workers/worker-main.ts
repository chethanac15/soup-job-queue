
import "dotenv/config";

import { pool } from "../database/db";
import { runWorkerLoop } from "./worker";

const workerId =
  process.env.WORKER_ID ||
  `worker-${process.env.HOSTNAME || process.pid}`;

const controller = new AbortController();

process.once("SIGINT", () => {
  console.log(`Worker ${workerId} received SIGINT`);
  controller.abort();
});

process.once("SIGTERM", () => {
  console.log(`Worker ${workerId} received SIGTERM`);
  controller.abort();
});

async function main(): Promise<void> {
  console.log(`Worker ${workerId} starting`);

  try {
    await runWorkerLoop(workerId, controller.signal);
  } finally {
    await pool.end();
    console.log(`Worker ${workerId} database connections closed`);
  }
}

main().catch((error: unknown) => {
  console.error(`Worker ${workerId} terminated unexpectedly:`, error);
  process.exitCode = 1;
});
