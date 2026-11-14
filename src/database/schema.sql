
-- =========================================================
-- SOUP JOB QUEUE
-- PostgreSQL Database Schema
-- =========================================================

-- UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. JOBS TABLE
-- =========================================================

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Idempotency
    idempotency_key TEXT NOT NULL UNIQUE,

    -- Job input
    payload JSONB NOT NULL,
    payload_hash TEXT NOT NULL,

    -- Job lifecycle
    status TEXT NOT NULL DEFAULT 'queued',

    -- Retry configuration
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,

    -- Worker ownership
    worker_id TEXT,
    lease_epoch BIGINT NOT NULL DEFAULT 0,
    lease_expires_at TIMESTAMPTZ,

    -- Cancellation
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,

    -- Error tracking
    failure_reason TEXT,
    last_error TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- Valid job states
    CONSTRAINT valid_job_status
        CHECK (
            status IN (
                'queued',
                'running',
                'succeeded',
                'failed',
                'cancelled'
            )
        ),

    -- Attempt limits
    CONSTRAINT valid_attempts
        CHECK (
            attempts >= 0
            AND max_attempts > 0
            AND attempts <= max_attempts
        ),

    -- Fencing token cannot be negative
    CONSTRAINT valid_lease_epoch
        CHECK (lease_epoch >= 0),

    -- Running jobs must have an owner and lease.
    -- Non-running jobs must not retain an active lease.
    CONSTRAINT valid_lease
        CHECK (
            (
                status = 'running'
                AND worker_id IS NOT NULL
                AND lease_expires_at IS NOT NULL
            )
            OR
            (
                status <> 'running'
                AND worker_id IS NULL
                AND lease_expires_at IS NULL
            )
        ),

    -- Completed jobs must have a completion timestamp.
    CONSTRAINT valid_completion_time
        CHECK (
            (
                status IN ('succeeded', 'failed', 'cancelled')
                AND completed_at IS NOT NULL
            )
            OR
            (
                status IN ('queued', 'running')
                AND completed_at IS NULL
            )
        )
);

-- =========================================================
-- 2. JOB EFFECTS TABLE
-- =========================================================

-- Stores the actual side effect of successful execution.
-- UNIQUE(job_id) prevents duplicate committed effect rows.

CREATE TABLE IF NOT EXISTS job_effects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    job_id UUID NOT NULL UNIQUE
        REFERENCES jobs(id),

    result JSONB NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- 3. INDEX FOR QUEUED JOB CLAIMING
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_jobs_queued
ON jobs (created_at, id)
WHERE status = 'queued';

-- =========================================================
-- 4. INDEX FOR EXPIRED LEASE RECOVERY
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_jobs_expired_leases
ON jobs (lease_expires_at)
WHERE status = 'running';

-- =========================================================
-- 5. INDEX FOR PAGINATED JOB LISTING
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_jobs_created
ON jobs (created_at DESC, id DESC);

-- =========================================================
-- 6. INDEX FOR IDEMPOTENCY LOOKUPS
-- =========================================================

-- The UNIQUE constraint on idempotency_key already creates
-- an index. No additional index is necessary.

-- =========================================================
-- END OF SOUP JOB QUEUE SCHEMA
-- =========================================================
