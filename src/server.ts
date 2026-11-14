
import "dotenv/config";
import { app } from "./app";
import { pool } from "./database/db";

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  console.log(`Soup API running on port ${PORT}`);
});

async function shutdown() {
  console.log("Shutting down Soup API...");

  server.close(async () => {
    try {
      await pool.end();
      console.log("Database connections closed");
      process.exit(0);
    } catch (error) {
      console.error("Shutdown error:", error);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
