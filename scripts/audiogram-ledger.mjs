import {DatabaseSync} from "node:sqlite";

const mapVideo = (row) =>
  row
    ? {
        videoId: row.video_id,
        title: row.title,
        sourceUrl: row.source_url,
        playlistId: row.playlist_id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }
    : null;

const mapJob = (row) =>
  row
    ? {
        id: row.id,
        videoId: row.video_id,
        treatmentVersion: row.treatment_version,
        status: row.status,
        heatmapJson: row.heatmap_json,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapClip = (row) => ({
  id: row.id,
  processingJobId: row.processing_job_id,
  rank: row.rank,
  startSeconds: row.start_seconds,
  endSeconds: row.end_seconds,
  score: row.score,
  status: row.status,
  artifactRelativePath: row.artifact_relative_path,
});

export const openAudiogramLedger = (
  path,
  {now = () => new Date().toISOString()} = {},
) => {
  const database = new DatabaseSync(path, {timeout: 5_000});

  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      playlist_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS processing_jobs (
      id INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
      treatment_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered'
        CHECK (status IN ('discovered', 'heatmap_ready', 'no_heatmap', 'failed', 'rendered')),
      heatmap_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (video_id, treatment_version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS clips (
      id INTEGER PRIMARY KEY,
      processing_job_id INTEGER NOT NULL
        REFERENCES processing_jobs(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL CHECK (rank >= 1),
      start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
      end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
      score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'selected'
        CHECK (status IN ('selected', 'media_ready', 'rendered', 'failed')),
      artifact_relative_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (processing_job_id, rank)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS processing_jobs_status_idx
      ON processing_jobs(status);
  `);

  const getVideoStatement = database.prepare(
    "SELECT * FROM videos WHERE video_id = ?",
  );
  const getJobStatement = database.prepare(
    "SELECT * FROM processing_jobs WHERE video_id = ? AND treatment_version = ?",
  );

  const syncPlaylistVideos = ({playlistId, treatmentVersion, videos}) => {
    let discovered = 0;
    let existing = 0;
    const timestamp = now();

    database.exec("BEGIN IMMEDIATE");
    try {
      const upsertVideo = database.prepare(`
        INSERT INTO videos (
          video_id, title, source_url, playlist_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          source_url = excluded.source_url,
          playlist_id = excluded.playlist_id,
          last_seen_at = excluded.last_seen_at
      `);
      const createJob = database.prepare(`
        INSERT INTO processing_jobs (
          video_id, treatment_version, status, created_at, updated_at
        ) VALUES (?, ?, 'discovered', ?, ?)
        ON CONFLICT(video_id, treatment_version) DO NOTHING
      `);

      for (const video of videos) {
        if (getVideoStatement.get(video.videoId)) {
          existing += 1;
        } else {
          discovered += 1;
        }

        upsertVideo.run(
          video.videoId,
          video.title,
          video.url,
          playlistId,
          timestamp,
          timestamp,
        );
        createJob.run(video.videoId, treatmentVersion, timestamp, timestamp);
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return {discovered, existing};
  };

  const recordHeatmapSelection = ({jobId, heatmap, clips}) => {
    const timestamp = now();
    const status = clips.length > 0 ? "heatmap_ready" : "no_heatmap";

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          UPDATE processing_jobs
          SET status = ?, heatmap_json = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(status, JSON.stringify(heatmap), timestamp, jobId);

      database
        .prepare(
          "DELETE FROM clips WHERE processing_job_id = ? AND status = 'selected'",
        )
        .run(jobId);

      const insertClip = database.prepare(`
        INSERT INTO clips (
          processing_job_id, rank, start_seconds, end_seconds, score,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'selected', ?, ?)
        ON CONFLICT(processing_job_id, rank) DO UPDATE SET
          start_seconds = excluded.start_seconds,
          end_seconds = excluded.end_seconds,
          score = excluded.score,
          updated_at = excluded.updated_at
      `);

      for (const clip of clips) {
        insertClip.run(
          jobId,
          clip.rank,
          clip.startSeconds,
          clip.endSeconds,
          clip.score,
          timestamp,
          timestamp,
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    close: () => database.close(),
    countProcessingJobs: () =>
      database.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()
        .count,
    countVideos: () =>
      database.prepare("SELECT COUNT(*) AS count FROM videos").get().count,
    getProcessingJob: (videoId, treatmentVersion) =>
      mapJob(getJobStatement.get(videoId, treatmentVersion)),
    getVideo: (videoId) => mapVideo(getVideoStatement.get(videoId)),
    listClips: (jobId) =>
      database
        .prepare(
          "SELECT * FROM clips WHERE processing_job_id = ? ORDER BY rank",
        )
        .all(jobId)
        .map(mapClip),
    listPendingJobs: () =>
      database
        .prepare(`
          SELECT
            processing_jobs.id,
            processing_jobs.video_id,
            processing_jobs.treatment_version,
            processing_jobs.status,
            processing_jobs.heatmap_json,
            processing_jobs.last_error,
            processing_jobs.created_at,
            processing_jobs.updated_at,
            videos.title,
            videos.source_url
          FROM processing_jobs
          JOIN videos USING (video_id)
          WHERE processing_jobs.status = 'discovered'
          ORDER BY processing_jobs.id
        `)
        .all()
        .map((row) => ({
          ...mapJob(row),
          title: row.title,
          sourceUrl: row.source_url,
        })),
    markJobFailed: (jobId, error) => {
      database
        .prepare(`
          UPDATE processing_jobs
          SET status = 'failed', last_error = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(String(error), now(), jobId);
    },
    recordHeatmapSelection,
    syncPlaylistVideos,
  };
};

