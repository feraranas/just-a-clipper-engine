import { DatabaseSync } from "node:sqlite";

export const readRecoverySnapshot = (db, itemId) => {
  try {
    const item = db.prepare("SELECT * FROM publishing_items WHERE id=?").get(itemId) ?? null;
    const columns = db.prepare("PRAGMA table_info(publishing_items)").all().map(r => r.name);
    if (!["approved_caption", "approved_artifact_hash", "safe_to_retry"].every(c => columns.includes(c))) throw new Error("Unsupported recovery schema");
    const attempt = db.prepare("SELECT * FROM publishing_attempts WHERE item_id=? ORDER BY sequence DESC LIMIT 1").get(itemId) ?? null;
    return {item, attempt};
  } catch { throw new Error("Unsupported recovery schema"); }
};

export const openRecoveryStore = path => {
  const db = new DatabaseSync(path, {readOnly:true, timeout:5000});
  return {close: () => db.close(), readSnapshot: itemId => readRecoverySnapshot(db, itemId)};
};
