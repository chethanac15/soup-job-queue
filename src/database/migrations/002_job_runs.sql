CREATE TABLE IF NOT EXISTS job_runs (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES jobs(id),
    attempt INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    lease_epoch BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'started',
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ,
    error_message TEXT,

    CONSTRAINT job_runs_unique_attempt
        UNIQUE (job_id, attempt),

    CONSTRAINT job_runs_valid_status
        CHECK (
            status IN (
                'started',
                'succeeded',
                'failed',
                'interrupted',
                'cancelled'
            )
        ),

    CONSTRAINT job_runs_valid_completion
        CHECK (
            (status = 'started' AND finished_at IS NULL)
            OR
            (status <> 'started' AND finished_at IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_id
    ON job_runs(job_id);

CREATE INDEX IF NOT EXISTS idx_job_runs_status
    ON job_runs(status);