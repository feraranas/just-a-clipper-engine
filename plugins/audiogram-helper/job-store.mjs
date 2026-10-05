import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createJobStore(filename) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  chmodSync(path.dirname(filename), 0o700);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, source_url TEXT NOT NULL,
      status TEXT NOT NULL, pid INTEGER, result_json TEXT, error TEXT,
      retry_of_job_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_video ON jobs(video_id) WHERE status IN ('queued','running');`);
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name);
  if (!columns.includes('retry_of_job_id')) db.exec('ALTER TABLE jobs ADD COLUMN retry_of_job_id TEXT');
  const decode = (row) => row && ({
    jobId: row.job_id, videoId: row.video_id, sourceUrl: row.source_url, status: row.status,
    pid: row.pid, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.retry_of_job_id ? { retryOfJobId: row.retry_of_job_id } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}), ...(row.error ? { error: row.error } : {}),
  });
  return {
    createOrGetJob({ videoId, sourceUrl }) {
      const existing = db.prepare("SELECT * FROM jobs WHERE video_id=? AND status IN ('queued','running')").get(videoId);
      if (existing) return { job: decode(existing), created: false };
      const jobId = randomUUID();
      db.prepare('INSERT INTO jobs(job_id,video_id,source_url,status) VALUES(?,?,?,?)').run(jobId, videoId, sourceUrl, 'queued');
      return { job: decode(db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId)), created: true };
    },
    createRetryJob({ priorJobId }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(priorJobId);
        if (!prior) throw new Error('Audiogram job was not found.');
        if (!['failed', 'partial'].includes(prior.status))
          throw new Error('Retry requires a terminal failed or partial job.');
        const jobId = randomUUID();
        db.prepare('INSERT INTO jobs(job_id,video_id,source_url,status,retry_of_job_id) VALUES(?,?,?,\'queued\',?)')
          .run(jobId, prior.video_id, prior.source_url, priorJobId);
        const job = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId);
        db.exec('COMMIT');
        return { job: decode(job), created: true };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    markRunning(jobId, pid) { db.prepare("UPDATE jobs SET status=CASE WHEN status='queued' THEN 'running' ELSE status END,pid=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?").run(pid, jobId); },
    setResult(jobId, result) { db.prepare('UPDATE jobs SET status=?,result_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?').run(result.status, JSON.stringify(result), typeof result.error === 'string' ? result.error : result.error?.message ?? null, jobId); },
    setFailed(jobId, message) { db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?").run(message, jobId); },
    getJob(jobId) { return decode(db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId)); },
    close() { db.close(); },
  };
}
