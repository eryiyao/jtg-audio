'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { openDatabase, toEpisode } = require('./db');

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_POSITION_SECONDS = 48 * 60 * 60;

function loadConfig(overrides = {}) {
  const root = path.resolve(__dirname, '..');
  const dataDir = path.resolve(overrides.dataDir || process.env.DATA_DIR || path.join(root, 'data'));
  const uploadDir = path.resolve(overrides.uploadDir || process.env.UPLOAD_DIR || path.join(root, 'uploads'));
  const defaultDb = path.join(dataDir, 'jtg.sqlite');
  const dbPath = path.resolve(
    overrides.dbPath
      || (overrides.dataDir ? defaultDb : (process.env.DATABASE_PATH || defaultDb))
  );
  let maxUploadMb = Number(overrides.maxUploadMb || process.env.MAX_UPLOAD_MB || 200);
  if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) maxUploadMb = 200;
  maxUploadMb = Math.min(maxUploadMb, 2048);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  return { root, dataDir, uploadDir, dbPath, maxUploadMb, port, host };
}

function extensionOf(filename) {
  const base = path.basename(String(filename || '').replace(/\\/g, '/')).trim();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

function fixUtf8(name) {
  const raw = String(name || '');
  if (/[^\u0000-\u00ff]/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) return raw;
  return decoded;
}

function cleanTitle(value, fallbackName) {
  const fromUser = String(value || '').replace(/[\u0000-\u001f]/g, '').trim();
  let title = fromUser;
  if (!title) {
    const base = path.basename(fixUtf8(fallbackName).replace(/\\/g, '/')).trim();
    const dot = base.lastIndexOf('.');
    title = (dot > 0 ? base.slice(0, dot) : base).trim();
  }
  title = title.slice(0, 120).trim();
  return title || '未命名音频';
}

function normalizeClientKey(value) {
  if (value == null || value === '') return 'browser';
  const key = String(value).trim();
  if (!CLIENT_KEY_RE.test(key)) return null;
  return key;
}

function readPosition(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_POSITION_SECONDS) return null;
  return Math.round(n * 10) / 10;
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const store = openDatabase(config.dbPath);

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename(req, file, cb) {
        const ext = extensionOf(file.originalname);
        const id = crypto.randomUUID();
        file.episodeId = id;
        file.storedName = `${id}${ext}`;
        cb(null, file.storedName);
      },
    }),
    limits: { fileSize: Math.round(config.maxUploadMb * 1024 * 1024), files: 1 },
    fileFilter(req, file, cb) {
      const ext = extensionOf(file.originalname);
      if (!AUDIO_TYPES[ext]) {
        cb(new Error('只支持常见音频，例如 mp3、m4a、wav'));
        return;
      }
      cb(null, true);
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.locals.db = store.db;
  app.locals.config = config;

  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  function sharedProgress(id) {
    // Until the first new-version playback, use the latest legacy browser save.
    // After a session is claimed, old pages cannot overwrite shared progress.
    const saved = store.getSharedProgress.get(id) || store.latestLegacyProgress.get(id);
    return { episodeId: id, positionSeconds: saved?.position_seconds ?? null,
      updatedAt: saved?.updated_at ?? null, sessionId: saved?.session_id ?? null,
      sequence: saved?.sequence ?? 0 };
  }

  app.get('/api/episodes', (req, res) => {
    const rows = store.listEpisodes.all();
    res.json(rows.map((row) => ({ ...toEpisode(row), progress: sharedProgress(row.id) })));
  });

  app.post('/api/episodes', (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
      if (err) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        next(err);
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: '请选择音频文件' });
        return;
      }
      if (!req.file.size) {
        fs.unlink(req.file.path, () => {});
        res.status(400).json({ error: '文件是空的' });
        return;
      }
      const id = req.file.episodeId;
      const originalName = path.basename(fixUtf8(req.file.originalname).replace(/\\/g, '/'));
      const title = cleanTitle(req.body && req.body.title, originalName);
      const ext = extensionOf(originalName);
      try {
        store.insertEpisode.run(
          id,
          title,
          req.file.storedName,
          originalName,
          AUDIO_TYPES[ext],
          req.file.size,
          new Date().toISOString()
        );
      } catch (insertErr) {
        fs.unlink(req.file.path, () => {});
        next(insertErr);
        return;
      }
      const row = store.getEpisode.get(id);
      res.status(201).json(toEpisode(row));
    });
  });

  app.patch('/api/episodes/:id', (req, res) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const duration = readPosition(req.body && req.body.durationSeconds);
    if (duration == null || duration <= 0) {
      res.status(400).json({ error: '时长无效' });
      return;
    }
    store.setDuration.run(duration, row.id);
    res.json(toEpisode(store.getEpisode.get(row.id)));
  });

  app.delete('/api/episodes/:id', (req, res, next) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const filePath = resolveUpload(config.uploadDir, row.stored_name);
    if (!filePath) {
      res.status(500).json({ error: '文件路径异常，未删除' });
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      // A missing file is already removed; any other failure must remain visible.
      if (err.code !== 'ENOENT') {
        console.error('Audio deletion failed:', err.code);
        res.status(500).json({ error: '文件删除失败，请稍后重试' });
        return;
      }
    }
    try { store.deleteEpisode.run(row.id); } catch (err) { next(err); return; }
    res.status(204).end();
  });

  app.get('/api/episodes/:id/audio', (req, res) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const filePath = resolveUpload(config.uploadDir, row.stored_name);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: '找不到音频文件' });
      return;
    }
    streamFile(req, res, filePath, row.mime_type);
  });

  app.get('/api/progress/:id', (req, res) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const clientKey = normalizeClientKey(req.query.clientKey);
    if (!clientKey) {
      res.status(400).json({ error: 'clientKey 无效' });
      return;
    }
    const progress = store.getProgress.get(row.id, clientKey);
    res.json({
      episodeId: row.id,
      clientKey,
      positionSeconds: progress ? progress.position_seconds : null,
      updatedAt: progress ? progress.updated_at : null,
    });
  });

  app.put('/api/progress/:id', (req, res) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const clientKey = normalizeClientKey(req.body && req.body.clientKey);
    if (!clientKey) {
      res.status(400).json({ error: 'clientKey 无效' });
      return;
    }
    const position = readPosition(req.body && req.body.positionSeconds);
    if (position == null) {
      res.status(400).json({ error: '进度无效' });
      return;
    }
    const updatedAt = new Date().toISOString();
    store.upsertProgress.run(row.id, clientKey, position, updatedAt);
    res.json({
      episodeId: row.id,
      clientKey,
      positionSeconds: position,
      updatedAt,
    });
  });

  app.get('/api/shared-progress/:id', (req, res) => {
    const row = findEpisode(store, req, res);
    if (row) res.json(sharedProgress(row.id));
  });

  app.post('/api/shared-progress/:id/session', (req, res) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const body = req.body || {};
    const before = sharedProgress(row.id);
    const candidate = body.positionSeconds == null ? null : readPosition(body.positionSeconds);
    if (body.positionSeconds != null && candidate == null) {
      res.status(400).json({ error: '进度无效' }); return;
    }
    // An explicit seek is intentional. Normal play resumes the cloud position,
    // unless this same session has a newer position not yet acknowledged.
    const ownSession = before.sessionId && body.previousSessionId === before.sessionId;
    let position = before.positionSeconds ?? candidate ?? 0;
    if (candidate != null && (body.seek === true || ownSession)) position = candidate;
    const sessionId = crypto.randomUUID();
    store.claimSharedProgress.run(row.id, position, new Date().toISOString(), sessionId);
    res.json(sharedProgress(row.id));
  });

  app.put('/api/shared-progress/:id', (req, res) => {
    const row = findEpisode(store, req, res);
    if (!row) return;
    const body = req.body || {};
    const position = readPosition(body.positionSeconds);
    if (position == null || !ID_RE.test(body.sessionId || '') || !Number.isSafeInteger(body.sequence) || body.sequence < 1) {
      res.status(400).json({ error: '进度参数无效' }); return;
    }
    const before = sharedProgress(row.id);
    if (before.sessionId !== body.sessionId) {
      res.status(409).json({ ...before, error: '已在另一台设备继续收听' }); return;
    }
    store.saveSharedProgress.run(position, new Date().toISOString(), body.sequence, row.id, body.sessionId, body.sequence);
    res.json(sharedProgress(row.id));
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: '没有这个接口' });
  });

  const publicDir = path.join(config.root, 'public');
  app.use(express.static(publicDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `文件超过 ${config.maxUploadMb} MB` });
      return;
    }
    if (err && err.message && err.message.startsWith('只支持常见音频')) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: '服务器出错了' });
  });

  return app;
}

function findEpisode(store, req, res) {
  if (!ID_RE.test(req.params.id || '')) {
    res.status(400).json({ error: '编号无效' });
    return null;
  }
  const row = store.getEpisode.get(req.params.id);
  if (!row) {
    res.status(404).json({ error: '找不到这条音频' });
    return null;
  }
  return row;
}

function resolveUpload(uploadDir, storedName) {
  if (!storedName || storedName !== path.basename(storedName)) return null;
  const full = path.resolve(uploadDir, storedName);
  const root = path.resolve(uploadDir) + path.sep;
  if (!full.startsWith(root)) return null;
  return full;
}

function streamFile(req, res, filePath, mimeType) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    res.status(404).json({ error: '找不到音频文件' });
    return;
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    pipeStream(req, res, fs.createReadStream(filePath));
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix)) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }
  end = Math.min(end, size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  pipeStream(req, res, fs.createReadStream(filePath, { start, end }));
}

function pipeStream(req, res, stream) {
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  const cleanup = () => stream.destroy();
  res.on('close', cleanup);
  req.on('aborted', cleanup);
  stream.pipe(res);
}

function start() {
  const config = loadConfig();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`听稿已启动：http://${config.host}:${config.port}`);
    console.log(`数据：${config.dbPath}`);
    console.log(`音频：${config.uploadDir}`);
  });
  server.on('error', (err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

if (require.main === module) start();

module.exports = { createApp, loadConfig };
