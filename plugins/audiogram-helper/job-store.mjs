import {resolveTemplateSelection} from "../../src/templates/catalog.mjs";
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createJobStore(filename, {resolveSelection = resolveTemplateSelection} = {}) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  chmodSync(path.dirname(filename), 0o700);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`);
  try {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, source_url TEXT NOT NULL,
      status TEXT NOT NULL, pid INTEGER, result_json TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_video ON jobs(video_id) WHERE status IN ('queued','running');`);
  const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name));
  if (!columns.has('render_key')) db.exec("ALTER TABLE jobs ADD COLUMN render_key TEXT NOT NULL DEFAULT 'audiogram-basic@1'");
  if (!columns.has('selection_json')) db.exec(`ALTER TABLE jobs ADD COLUMN selection_json TEXT NOT NULL DEFAULT '${JSON.stringify(resolveTemplateSelection().selection)}'`);
  db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
  const decode = (row) => row && ({
    jobId: row.job_id, videoId: row.video_id, sourceUrl: row.source_url, status: row.status,
    selection: JSON.parse(row.selection_json), renderKey: row.render_key,
    pid: row.pid, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}), ...(row.error ? { error: row.error } : {}),
  });
  return {
    createOrGetJob({ videoId, sourceUrl, selection, renderKey }) {
      const resolved = resolveSelection(selection);
      if (renderKey !== undefined && renderKey !== resolved.renderKey) throw new Error('Render identity does not match selection');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare("SELECT * FROM jobs WHERE video_id=? AND status IN ('queued','running')").get(videoId);
        if (existing) {
          if (existing.render_key !== resolved.renderKey) {
            throw Object.assign(new Error('This video already has an active job for another template. Wait for that job to finish.'), {code:'VIDEO_BUSY_DIFFERENT_TEMPLATE'});
          }
          db.exec('COMMIT');
          return {job:decode(existing),created:false};
        }
        const jobId = randomUUID();
        db.prepare('INSERT INTO jobs(job_id,video_id,source_url,status,render_key,selection_json) VALUES(?,?,?,?,?,?)')
          .run(jobId, videoId, sourceUrl, 'queued', resolved.renderKey, JSON.stringify(resolved.selection));
        const job=decode(db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId));
        db.exec('COMMIT');
        return {job,created:true};
      } catch(error) {
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
