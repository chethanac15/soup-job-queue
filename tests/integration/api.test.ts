import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

import { app } from "../../src/app";
import { pool } from "../../src/database/db";

const testPrefix = `vitest-api-${randomUUID()}-`;

function idempotencyKey(label: string): string {
  return `${testPrefix}${label}`;
}

describe("Jobs API integration tests", () => {
  afterAll(async () => {
    // Remove only records created by this test suite.
    await pool.query(
      `
        DELETE FROM job_runs
        WHERE job_id IN (
          SELECT id FROM jobs WHERE idempotency_key LIKE $1
        )
      `,
      [`${testPrefix}%`]
    );

    await pool.query(
      `
        DELETE FROM job_effects
        WHERE job_id IN (
          SELECT id FROM jobs WHERE idempotency_key LIKE $1
        )
      `,
      [`${testPrefix}%`]
    );

    await pool.query(
      "DELETE FROM jobs WHERE idempotency_key LIKE $1",
      [`${testPrefix}%`]
    );

    await pool.end();
  });

  it("returns a healthy response", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it("creates a job and returns its ID and queued status", async () => {
    const response = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", idempotencyKey("create"))
      .send({
        payload: { task: "integration-test" }
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.created).toBe(true);
    expect(response.body.job.id).toBeTruthy();
    expect(response.body.job.status).toBe("queued");
    expect(response.body.job.payload).toEqual({
      task: "integration-test"
    });
  });

  it("returns the existing job for a repeated idempotency key", async () => {
    const key = idempotencyKey("duplicate");
    const payload = { task: "same-payload", amount: 10 };

    const first = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", key)
      .send({ payload });

    const second = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", key)
      .send({
        // Different property order should still represent the same payload.
        payload: { amount: 10, task: "same-payload" }
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(first.body.job.id).toBe(second.body.job.id);
    expect(second.body.created).toBe(false);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    const key = idempotencyKey("conflict");

    const first = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", key)
      .send({ payload: { task: "original" } });

    const second = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", key)
      .send({ payload: { task: "different" } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("handles simultaneous duplicate submissions without creating two jobs", async () => {
    const key = idempotencyKey("concurrent-duplicate");
    const payload = { task: "concurrent-test" };

    const responses = await Promise.all([
      request(app)
        .post("/jobs")
        .set("Idempotency-Key", key)
        .send({ payload }),
      request(app)
        .post("/jobs")
        .set("Idempotency-Key", key)
        .send({ payload })
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200,
      201
    ]);

    expect(responses[0].body.job.id).toBe(responses[1].body.job.id);

    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM jobs WHERE idempotency_key = $1",
      [key]
    );

    expect(count.rows[0].count).toBe(1);
  });

  it("gets a job by ID and returns 404 for an unknown ID", async () => {
    const created = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", idempotencyKey("get"))
      .send({ payload: { task: "get-test" } });

    const jobId = created.body.job.id;

    const found = await request(app).get(`/jobs/${jobId}`);

    expect(found.status).toBe(200);
    expect(found.body.job.id).toBe(jobId);

    const missing = await request(app).get(
      "/jobs/00000000-0000-4000-8000-000000000000"
    );

    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("JOB_NOT_FOUND");
  });

  it("cancels a queued job", async () => {
    const created = await request(app)
      .post("/jobs")
      .set("Idempotency-Key", idempotencyKey("cancel"))
      .send({ payload: { task: "cancel-test" } });

    const jobId = created.body.job.id;

    const cancelled = await request(app).post(`/jobs/${jobId}/cancel`);

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job.status).toBe("cancelled");
    expect(cancelled.body.job.cancel_requested).toBe(true);
    expect(cancelled.body.job.completed_at).toBeTruthy();
  });

  it("validates missing idempotency keys and invalid pagination cursors", async () => {
    const missingKey = await request(app)
      .post("/jobs")
      .send({ payload: { task: "invalid" } });

    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error).toBe("VALIDATION_ERROR");

    const invalidCursor = await request(app)
      .get("/jobs")
      .query({ cursor: "not-a-valid-cursor" });

    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error).toBe("INVALID_CURSOR");
  });

  it("returns a bounded page of jobs", async () => {
    await request(app)
      .post("/jobs")
      .set("Idempotency-Key", idempotencyKey("page-one"))
      .send({ payload: { page: 1 } });

    await request(app)
      .post("/jobs")
      .set("Idempotency-Key", idempotencyKey("page-two"))
      .send({ payload: { page: 2 } });

    const firstPage = await request(app)
      .get("/jobs")
      .query({ limit: 1 });

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.jobs).toHaveLength(1);
    expect(firstPage.body.count).toBe(1);
  });
});