'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_seconds REAL,
      created_at TEXT NOT NULL
    );
  `);
  // client_key 目前是浏览器自己生成的 id。以后加登录时，换成用户 id，
  // 同一条进度就能跨设备共用。表结构不用再拆。
  db.exec(`
    CREATE TABLE IF NOT EXISTS progress (
      episode_id TEXT NOT NULL,
      client_key TEXT NOT NULL,
      position_seconds REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (episode_id, client_key),
      FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
    );
  `);

  return {
    db,
    insertEpisode: db.prepare(`
      INSERT INTO episodes (
        id, title, stored_name, original_name, mime_type, size_bytes, duration_seconds, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `),
    listEpisodes: db.prepare(`
      SELECT * FROM episodes ORDER BY created_at DESC
    `),
    getEpisode: db.prepare(`
      SELECT * FROM episodes WHERE id = ?
    `),
    setDuration: db.prepare(`
      UPDATE episodes SET duration_seconds = ? WHERE id = ?
    `),
    deleteEpisode: db.prepare(`
      DELETE FROM episodes WHERE id = ?
    `),
    getProgress: db.prepare(`
      SELECT position_seconds, updated_at
      FROM progress
      WHERE episode_id = ? AND client_key = ?
    `),
    upsertProgress: db.prepare(`
      INSERT INTO progress (episode_id, client_key, position_seconds, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(episode_id, client_key) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        updated_at = excluded.updated_at
    `),
  };
}

function toEpisode(row) {
  return {
    id: row.id,
    title: row.title,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    audioUrl: `/api/episodes/${row.id}/audio`,
  };
}

module.exports = { openDatabase, toEpisode };
