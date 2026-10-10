import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  artifactLocation,
  hashFile,
  storeArtifact,
} from "./artifact-store.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const update = (db, table, oldPath, newPath, expectedHash) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (table === "publishing_items")
      db.prepare(
        "UPDATE publishing_items SET artifact_relative_path = ? WHERE artifact_relative_path = ? AND artifact_hash = ?",
      ).run(newPath, oldPath, expectedHash);
    else
      db.prepare(
        "UPDATE treatment_runs SET artifact_relative_path = ? WHERE artifact_relative_path = ?",
      ).run(newPath, oldPath);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const migrateArtifactStorage = async ({
  sourceRoots,
  publishingDb,
  processingDb,
  artifactRoot,
  apply = false,
}) => {
  // Refuse typos: this maintenance command never creates a database.
  await access(publishingDb);
  const publishing = new DatabaseSync(publishingDb, { readOnly: !apply });
  let processing;
  const mappings = new Map();
  const report = { apply, migrated: [], unresolved: [] };
  try {
    if (processingDb && (await exists(processingDb)))
      processing = new DatabaseSync(processingDb, { readOnly: !apply });
    const queue = publishing
      .prepare(
        "SELECT id,artifact_relative_path,artifact_hash FROM publishing_items",
      )
      .all();
    const runs = processing
      ? processing
          .prepare(
            "SELECT id,artifact_relative_path FROM treatment_runs WHERE status='rendered'",
          )
          .all()
      : [];
    const candidates = [
      ...queue.map((row) => ({
        path: row.artifact_relative_path,
        hash: row.artifact_hash,
      })),
      ...runs.map((row) => ({ path: row.artifact_relative_path })),
    ];
    for (const candidate of candidates) {
      const oldPath = candidate.path;
      if (!oldPath || oldPath.startsWith("artifacts/")) continue;
      const key = `${oldPath}:${candidate.hash ?? ""}`;
      if (mappings.has(key)) continue;
      const journalDirectory = join(
        artifactRoot,
        "artifact-migrations",
        createHash("sha256").update(oldPath).digest("hex"),
      );
      // Durable checkpoints retain the old reference and its verified hash even
      // if one database committed and the other update was interrupted.
      if (!candidate.hash) {
        let entries = [];
        try {
          entries = await readdir(journalDirectory);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (entries.length) {
          const records = await Promise.all(
            entries
              .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
              .map(async (name) =>
                JSON.parse(
                  await readFile(join(journalDirectory, name), "utf8"),
                ),
              ),
          );
          const matches = records.filter(
            (record) => record.oldPath === oldPath,
          );
          if (matches.length !== 1) {
            report.unresolved.push({
              reference: oldPath,
              reason: "Migration history is ambiguous.",
            });
            continue;
          }
          const record = matches[0];
          const location = await artifactLocation(
            sourceRoots[0],
            record.newPath,
            { artifactRoot },
          );
          if ((await hashFile(location.path)) !== record.hash)
            throw Error("Migration checkpoint artifact is invalid");
          try {
            if (apply)
              update(processing, "treatment_runs", oldPath, record.newPath);
          } catch {
            report.unresolved.push({
              reference: oldPath,
              reason:
                "Processing ledger reconciliation failed; durable checkpoint preserved.",
            });
            continue;
          }
          report.migrated.push({
            reference: oldPath,
            durableReference: record.newPath,
            status: apply ? "reconciled" : "verified-checkpoint",
          });
          continue;
        }
      }

      let source;
      for (const root of sourceRoots) {
        try {
          const location = await artifactLocation(root, oldPath, {
            artifactRoot,
          });
          const hash = await hashFile(location.path);
          if (candidate.hash && candidate.hash !== hash) continue;
          source = { ...location, hash, projectRoot: root };
          break;
        } catch {
          /* Try only the explicitly named roots. */
        }
      }
      if (!source) {
        report.unresolved.push({
          reference: oldPath,
          reason: "No source matches the saved artifact identity.",
        });
        continue;
      }
      // Processing rows lack hashes. Require consistency with every queue record
      // for this path before changing a processing reference.
      if (
        !candidate.hash &&
        queue.some(
          (row) =>
            row.artifact_relative_path === oldPath &&
            row.artifact_hash !== source.hash,
        )
      ) {
        report.unresolved.push({
          reference: oldPath,
          reason:
            "Historical queue identities disagree; processing reference left unchanged.",
        });
        continue;
      }
      const manifestPath = source.path.replace(/\.mp4$/, ".manifest.json");
      const manifestExists = await exists(manifestPath);
      if (manifestExists && (await lstat(manifestPath)).isSymbolicLink()) {
        report.unresolved.push({
          reference: oldPath,
          reason: "Manifest symlink is not permitted.",
        });
        continue;
      }
      if (!apply) {
        report.migrated.push({ reference: oldPath, status: "verified-source" });
        continue;
      }
      try {
        const newPath = await storeArtifact({
          projectRoot: source.projectRoot,
          videoPath: source.path,
          manifestPath: manifestExists ? manifestPath : undefined,
          artifactRoot,
          expectedHash: source.hash,
        });
        await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
        const recordPath = join(
          journalDirectory,
          source.hash.slice(7) + ".json",
        );
        const record =
          JSON.stringify({ oldPath, newPath, hash: source.hash }) + "\n";
        try {
          await writeFile(recordPath, record, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (
            error.code !== "EEXIST" ||
            (await readFile(recordPath, "utf8")) !== record
          )
            throw error;
        }
        update(publishing, "publishing_items", oldPath, newPath, source.hash);
        if (
          processing &&
          !queue.some(
            (row) =>
              row.artifact_relative_path === oldPath &&
              row.artifact_hash !== source.hash,
          )
        )
          update(processing, "treatment_runs", oldPath, newPath);
        mappings.set(key, newPath);
        report.migrated.push({
          reference: oldPath,
          durableReference: newPath,
          status: "migrated",
        });
      } catch {
        report.unresolved.push({
          reference: oldPath,
          reason:
            "Verified promotion or ledger update failed; source files preserved.",
        });
      }
    }
    return report;
  } finally {
    processing?.close();
    publishing.close();
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        "source-root": { type: "string", multiple: true },
        apply: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (!values["source-root"]?.length)
      throw Error("At least one --source-root ABSOLUTE_PATH is required");
    const storage = resolveStorageConfig();
    const report = await migrateArtifactStorage({
      sourceRoots: values["source-root"].map((path) => {
        if (!path.startsWith("/")) throw Error("Source roots must be absolute");
        return resolve(path);
      }),
      publishingDb: storage.publishingDb,
      processingDb: storage.processingDb,
      artifactRoot: storage.artifactRoot,
      apply: values.apply,
    });
    console.log(JSON.stringify(report));
    process.exitCode = report.unresolved.length ? 1 : 0;
  } catch {
    console.error(
      "Artifact migration failed. Check the explicit source roots and storage configuration. No source files are deleted.",
    );
    process.exitCode = 1;
  }
}
