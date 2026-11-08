'use strict';
/**
 * Smart Hamster Cage - backend
 * ESP32 --(HTTP POST /api/telemetry)--> Express --> MySQL --> Dashboard (public/) + export dataset
 *
 * Bukan production-ready: dashboard tanpa login (dipakai di jaringan lokal saja).
 */
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';
const ML_API_KEY = process.env.ML_API_KEY || '';
const OFFLINE_AFTER_SEC = Number(process.env.OFFLINE_AFTER_SEC || 180);
const CMD_TTL_SEC = 300;                  // perintah feeding kadaluarsa setelah 5 menit
const CHART_MAX_POINTS = 1500;            // batas titik per grafik di dashboard
const TZ = 'Asia/Jakarta';

if (DEVICE_API_KEY.length < 16 || DEVICE_API_KEY.startsWith('<')) {
  console.error('[config] DEVICE_API_KEY di .env wajib diisi (minimal 16 karakter).');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'hamster_iot',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',            // semua DATETIME dibaca/ditulis sebagai UTC
  decimalNumbers: true,     // DECIMAL -> number, bukan string
});

// ---------------------------------------------------------------- helpers
class ValidationError extends Error {}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

function requireKey(expected) {
  return (req, res, next) => {
    if (!expected || !safeEqual(req.get('X-API-Key'), expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function num(body, key, min, max, { nullable = false, integer = false } = {}) {
  const v = body[key];
  if (v === null || v === undefined || v === '') {
    if (nullable) return null;
    throw new ValidationError(`${key} wajib diisi`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${key} harus angka ${min}..${max}`);
  }
  return integer ? Math.round(n) : n;
}

function flag(body, key, { nullable = false } = {}) {
  const v = body[key];
  if ((v === null || v === undefined) && nullable) return null;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  throw new ValidationError(`${key} harus 0/1`);
}

function oneOf(body, key, allowed, { nullable = false } = {}) {
  const v = body[key];
  if ((v === null || v === undefined || v === '') && nullable) return null;
  if (!allowed.includes(v)) throw new ValidationError(`${key} harus salah satu: ${allowed.join(', ')}`);
  return v;
}

function deviceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new ValidationError('device_id tidak valid');
  }
  return value;
}

const fmtWIB = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const toWIB = (d) => (d ? fmtWIB.format(d) : '');

function parseDateWIB(str, endOfDay) {
  if (!str) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new ValidationError('format tanggal harus YYYY-MM-DD');
  const d = new Date(`${str}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+07:00`);
  if (Number.isNaN(d.getTime())) throw new ValidationError('tanggal tidak valid');
  return d;
}

async function resolveDevice(req) {
  if (req.query.device) return deviceId(req.query.device);
  const live = newestLive();
  if (live) return live.device_id;
  const [rows] = await pool.query('SELECT device_id FROM telemetry ORDER BY recorded_at DESC LIMIT 1');
  return rows.length ? rows[0].device_id : null;
}

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------- telemetry parsing & events
function parseTelemetry(b) {
  const now = Date.now();
  const ts = num(b, 'ts', 0, 4102444800, { nullable: true, integer: true }); // epoch detik dari NTP
  const deviceTimeOk = ts && ts > 1700000000 && Math.abs(ts * 1000 - now) < 24 * 3600 * 1000;
  const ldr = num(b, 'ldr', 0, 4095, { nullable: true, integer: true });

  return {
    device_id: deviceId(b.device_id),
    recorded_at: deviceTimeOk ? new Date(ts * 1000) : new Date(now),
    time_source: deviceTimeOk ? 'device' : 'server',
    mode: oneOf(b, 'mode', ['test', 'final']),
    slot_sec: num(b, 'slot_sec', 1, 3600, { integer: true }),
    temperature: num(b, 'temp', -20, 80, { nullable: true }),
    humidity: num(b, 'humidity', 0, 100, { nullable: true }),
    ldr_raw: ldr,
    light_pct: ldr === null ? null : Math.round(((4095 - ldr) / 4095) * 10000) / 100,
    active_sec: num(b, 'active_sec', 0, 3600, { integer: true }),
    pir_ready: flag(b, 'pir_ready'),
    inactivity_status: oneOf(b, 'inactivity', ['WARMUP', 'NORMAL', 'WARNING', 'CRITICAL']),
    idle_sec: num(b, 'idle_sec', 0, 10 * 365 * 86400, { integer: true }),
    fan_state: flag(b, 'fan'),
    fan_by_temp: flag(b, 'fan_by_temp'),
    fan_by_hum: flag(b, 'fan_by_hum'),
    red_led: flag(b, 'red_led'),
    white_led: flag(b, 'white_led'),
    is_daytime: flag(b, 'is_daytime', { nullable: true }),
    feed_event: num(b, 'feed_events', 0, 20, { integer: true }),
    feed_reason: oneOf(b, 'feed_reason', ['activity', 'daily', 'fallback', 'manual'], { nullable: true }),
    feeds_in_period: num(b, 'feeds_in_period', 0, 20, { integer: true }),
  };
}

// ---------------------------------------------------------------- data live (tidak disimpan ke telemetry)
// ESP32 mengirim bacaan terakhir tiap 1 detik ke /api/live untuk dashboard real-time.
// Dataset (tabel telemetry) hanya berisi 1 record rata-rata per menit dari /api/telemetry.
const liveState = new Map();   // device_id -> data live terakhir (bentuknya sama dengan baris telemetry)

function newestLive() {
  let best = null;
  for (const v of liveState.values()) if (!best || v.created_at > best.created_at) best = v;
  return best && Date.now() - best.created_at.getTime() < OFFLINE_AFTER_SEC * 1000 ? best : null;
}

function freshLive(dev) {
  const v = liveState.get(dev);
  return v && Date.now() - v.created_at.getTime() < OFFLINE_AFTER_SEC * 1000 ? v : null;
}

function fanReason(d) {
  if (d.fan_by_temp && d.fan_by_hum) return 'temp+humidity';
  if (d.fan_by_temp) return 'temp';
  if (d.fan_by_hum) return 'humidity';
  return 'normal';
}

function diffEvents(prev, d) {
  const ev = [];
  const changed = (k) => (prev ? Number(prev[k]) !== Number(d[k]) : Number(d[k]) === 1);
  const first = !prev;

  if (changed('fan_state')) ev.push(['fan', d.fan_state ? 'ON' : 'OFF', first ? 'initial' : fanReason(d)]);
  if (changed('red_led')) ev.push(['red_led', d.red_led ? 'ON' : 'OFF', d.red_led ? 'rh_high' : 'rh_normal']);
  if (changed('white_led')) {
    ev.push(['white_led', d.white_led ? 'ON' : 'OFF', d.white_led ? 'dark' : 'bright']);
  }
  for (let i = 0; i < d.feed_event; i++) ev.push(['feeder', 'OPEN', d.feed_reason || 'unknown']);
  if (prev && prev.inactivity_status !== d.inactivity_status) {
    ev.push(['inactivity', d.inactivity_status, `idle ${d.idle_sec}s`]);
  }
  return ev.map(([actuator, state, reason]) => [d.device_id, d.recorded_at, d.mode, actuator, state, reason]);
}

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js disajikan dari node_modules -> dashboard tetap jalan tanpa internet
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

// ---- ESP32 -> server: data live tiap 1 detik (dashboard, log aktuator, perintah, riwayat feeding)
app.post('/api/live', express.json({ limit: '4kb' }), requireKey(DEVICE_API_KEY), asyncRoute(async (req, res) => {
  const d = parseTelemetry(req.body || {});
  d.slot_active_sec = num(req.body, 'slot_active_sec', 0, 3600, { nullable: true, integer: true });
  const now = new Date();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // perubahan aktuator dicatat saat itu juga (tepat ke detik), dibanding data live sebelumnya
    let prev = liveState.get(d.device_id);
    if (!prev || prev.mode !== d.mode) {
      const [rows] = await conn.query(
        'SELECT fan_state, red_led, white_led, inactivity_status FROM telemetry WHERE device_id = ? AND mode = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
        [d.device_id, d.mode]
      );
      prev = rows[0];
    }
    const events = diffEvents(prev, d);
    if (events.length) {
      await conn.query('INSERT INTO actuator_events (device_id, recorded_at, mode, actuator, state, reason) VALUES ?', [events]);
    }

    // ambil perintah pending dari dashboard
    await conn.query(
      "UPDATE commands SET status = 'expired' WHERE device_id = ? AND status = 'pending' AND created_at < ?",
      [d.device_id, new Date(now.getTime() - CMD_TTL_SEC * 1000)]
    );
    const [cmds] = await conn.query(
      "SELECT id, command FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY id FOR UPDATE",
      [d.device_id]
    );
    if (cmds.length) {
      await conn.query("UPDATE commands SET status = 'sent', sent_at = ? WHERE id IN (?)", [now, cmds.map((c) => c.id)]);
    }

    // rekomendasi kipas dari model ML (dipakai di AOL)
    const [pred] = await conn.query(
      'SELECT predicted_temp, fan_command FROM predictions WHERE device_id = ? AND target_time >= ? ORDER BY created_at DESC LIMIT 1',
      [d.device_id, now]
    );

    // riwayat feeding dari dataset -> ESP32 menentukan kuota & fallback dari sini
    const feed = await feedHistory(conn, d.device_id, d.mode, d.recorded_at);

    await conn.commit();
    liveState.set(d.device_id, { ...d, created_at: now });
    res.json({
      ok: true,
      feed,
      commands: cmds.map((c) => c.command),
      ml: pred.length ? { predicted_temp: pred[0].predicted_temp, fan: pred[0].fan_command } : null,
      server_time: Math.floor(now.getTime() / 1000),
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// ---- ESP32 -> server: 1 record dataset per menit (rata-rata), disimpan ke telemetry untuk ML
app.post('/api/telemetry', express.json({ limit: '4kb' }), requireKey(DEVICE_API_KEY), asyncRoute(async (req, res) => {
  const d = parseTelemetry(req.body || {});
  const now = new Date();
  // created_at diisi dari Node (UTC) supaya tidak tergantung time zone MySQL
  const [ins] = await pool.query('INSERT INTO telemetry SET ?', [{ ...d, created_at: now }]);
  // dihitung setelah insert -> menit aktif sudah termasuk menit ini (dipakai ESP32 untuk cek feeding)
  const feed = await feedHistory(pool, d.device_id, d.mode, d.recorded_at);
  res.json({ ok: true, id: ins.insertId, feed, server_time: Math.floor(now.getTime() / 1000) });
}));

// ---- dashboard API
app.get('/api/latest', asyncRoute(async (req, res) => {
  const dev = await resolveDevice(req);
  if (!dev) return res.json({ device_id: null });

  const [[stored]] = await pool.query(
    'SELECT * FROM telemetry WHERE device_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1', [dev]
  );
  const live = freshLive(dev);
  const row = live || stored;   // kartu dashboard memakai data live (1 detik); jika tidak ada, record terakhir
  const [[lastFeed]] = row ? await pool.query(
    `SELECT recorded_at, reason AS feed_reason FROM actuator_events
     WHERE device_id = ? AND mode = ? AND actuator = 'feeder' ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [dev, row.mode]
  ) : [[]];
  const [[pending]] = await pool.query(
    "SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND status = 'pending'", [dev]
  );
  const [[pred]] = await pool.query(
    'SELECT base_time, target_time, predicted_temp, confidence, model_name, fan_command FROM predictions WHERE device_id = ? ORDER BY created_at DESC LIMIT 1', [dev]
  );
  const ageSec = row ? (Date.now() - row.created_at.getTime()) / 1000 : null;

  res.json({
    device_id: dev,
    online: ageSec !== null && ageSec < Math.max(OFFLINE_AFTER_SEC, (row?.slot_sec || 0) * 3),
    age_sec: ageSec,
    latest: row || null,
    live: Boolean(live),
    stored: stored ? { recorded_at: stored.recorded_at, slot_sec: stored.slot_sec } : null,
    activity: row ? await activityWindow(dev, row) : null,
    feeds: row ? await feedQuota(dev, row.mode) : null,
    last_feed: lastFeed || null,
    pending_commands: pending.n,
    prediction: pred || null,
  });
}));

/** Aktivitas untuk syarat feeding: jumlah menit aktif (gerak > 5 detik) dalam 20 menit terakhir. */
async function activityWindow(dev, latest) {
  const end = latest.recorded_at.getTime();
  const activeMinutes = await countActiveMinutes(pool, dev, latest.mode, latest.recorded_at);
  if (latest.slot_active_sec !== undefined && latest.slot_active_sec !== null) {   // data live
    return {
      active_minutes: activeMinutes,
      window_min: FEED_RULE.windowMs / 60000,
      needed: FEED_RULE.minActive,
      last_minute_sec: latest.slot_active_sec,
    };
  }
  const [[minute]] = await pool.query(
    'SELECT COALESCE(SUM(active_sec), 0) AS sec FROM telemetry WHERE device_id = ? AND mode = ? AND recorded_at > ? AND recorded_at <= ?',
    [dev, latest.mode, new Date(end - 60000), latest.recorded_at]
  );
  return {
    active_minutes: activeMinutes,
    window_min: FEED_RULE.windowMs / 60000,
    needed: FEED_RULE.minActive,
    last_minute_sec: Number(minute.sec),
  };
}

// Kuota feeding per mode (sama dengan firmware: final 2x/24 jam, TEST_MODE 2x/10 menit)
const FEED_PERIOD_MS = { final: 24 * 3600 * 1000, test: 10 * 60 * 1000 };
const FEED_HISTORY_MS = 24 * 3600 * 1000;      // umur feeding yang dikirim ke ESP32
const FEED_SINCE_MAX_SEC = 7 * 86400;          // batas "sejak feeding terakhir" (cukup untuk fallback 24 jam)

/**
 * Riwayat feeding dari dataset (tabel actuator_events, feeder OPEN; dicatat saat feeding terjadi,
 * tidak menunggu record 1 menit), dihitung mundur dari waktu `at`.
 * ages_sec       : umur tiap feeding dalam 24 jam terakhir (detik, terbaru dulu) -> kuota 2x/24 jam
 * since_last_sec : detik sejak feeding terakhir, atau sejak record pertama jika belum pernah -> fallback & jeda 3 jam
 * active_minutes : menit aktif dalam 20 menit terakhir (sama dengan dashboard; hanya mode final)
 */
async function feedHistory(db, dev, mode, at) {
  const atMs = at.getTime();
  const ageSec = (t) => Math.max(0, Math.round((atMs - t.getTime()) / 1000));

  const [rows] = await db.query(
    `SELECT recorded_at FROM actuator_events
     WHERE device_id = ? AND mode = ? AND actuator = 'feeder' AND recorded_at > ? AND recorded_at <= ?
     ORDER BY recorded_at DESC LIMIT 10`,
    [dev, mode, new Date(atMs - FEED_HISTORY_MS), at]
  );
  const ages = rows.map((r) => ageSec(r.recorded_at));

  const [[h]] = await db.query(
    `SELECT (SELECT MAX(recorded_at) FROM actuator_events WHERE device_id = ? AND mode = ? AND actuator = 'feeder' AND recorded_at <= ?) AS last_feed,
            (SELECT MIN(recorded_at) FROM telemetry WHERE device_id = ? AND mode = ?) AS first_record`,
    [dev, mode, at, dev, mode]
  );
  const ref = h.last_feed || h.first_record || at;
  const history = {
    ages_sec: ages,
    since_last_sec: Math.min(ageSec(ref), FEED_SINCE_MAX_SEC),
    has_fed: Boolean(h.last_feed),
  };
  // TEST_MODE memakai slot 5 detik, jadi hitungan per menit hanya untuk mode final
  if (mode === 'final') history.active_minutes = await countActiveMinutes(db, dev, mode, at);
  return history;
}

/** Kuota feeding untuk dashboard, dihitung dari dataset (bukan dari angka ESP32). */
async function feedQuota(dev, mode) {
  const periodMs = FEED_PERIOD_MS[mode];
  const [[q]] = await pool.query(
    "SELECT COUNT(*) AS n FROM actuator_events WHERE device_id = ? AND mode = ? AND actuator = 'feeder' AND recorded_at > ?",
    [dev, mode, new Date(Date.now() - periodMs)]
  );
  return { count: Number(q.n), max: FEED_RULE.maxPerDay, period_label: mode === 'test' ? '10 menit' : '24 jam' };
}

/** Jumlah menit aktif (gerak > 5 detik) dalam 20 menit sebelum `end`. Dipakai dashboard dan ESP32. */
async function countActiveMinutes(db, dev, mode, end) {
  const [[win]] = await db.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT SUM(active_sec) AS sec FROM telemetry
       WHERE device_id = ? AND mode = ? AND recorded_at > ? AND recorded_at <= ?
       GROUP BY FLOOR(UNIX_TIMESTAMP(recorded_at) / 60)
     ) m WHERE sec > ?`,
    [dev, mode, new Date(end.getTime() - FEED_RULE.windowMs), end, LABEL_TH.activeSec]
  );
  return Number(win.n);
}

const MAX_RANGE_DAYS = 31;

/** Rentang grafik: ?from=&to= (ISO datetime) untuk rentang bebas, atau ?hours= untuk N jam terakhir. */
function chartRange(q) {
  if (q.from || q.to) {
    const since = new Date(q.from);
    const until = new Date(q.to);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      throw new ValidationError('from dan to harus tanggal-jam yang valid');
    }
    if (until <= since) throw new ValidationError('"Sampai" harus setelah "Dari"');
    if (until - since > MAX_RANGE_DAYS * 86400 * 1000) throw new ValidationError(`rentang maksimal ${MAX_RANGE_DAYS} hari`);
    return { since, until };
  }
  const hours = Math.min(Math.max(Number(q.hours) || 6, 0.25), 24 * 14);
  const until = new Date();
  return { since: new Date(until.getTime() - hours * 3600 * 1000), until };
}

app.get('/api/telemetry', asyncRoute(async (req, res) => {
  const dev = await resolveDevice(req);
  if (!dev) return res.json({ bucket_sec: 0, rows: [] });
  const mode = req.query.mode ? oneOf(req.query, 'mode', ['test', 'final']) : null;
  const { since, until } = chartRange(req.query);
  // rentang panjang (mis. 7 hari = 10.080 record) diringkas jadi maks. ~1.500 titik per grafik
  const bucketSec = Math.max(1, Math.ceil((until - since) / 1000 / CHART_MAX_POINTS));

  const params = [dev, since, until];
  let sql = `SELECT MIN(recorded_at) AS recorded_at,
                    AVG(temperature) AS temperature, AVG(humidity) AS humidity, AVG(light_pct) AS light_pct,
                    SUM(active_sec) / SUM(slot_sec) * 100 AS active_pct,
                    MAX(fan_state) AS fan_state, MAX(red_led) AS red_led, MAX(white_led) AS white_led,
                    SUM(feed_event) AS feed_event
             FROM telemetry WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?`;
  if (mode) { sql += ' AND mode = ?'; params.push(mode); }
  sql += ' GROUP BY FLOOR(UNIX_TIMESTAMP(recorded_at) / ?) ORDER BY recorded_at ASC';
  params.push(bucketSec);
  const [rows] = await pool.query(sql, params);
  res.json({ bucket_sec: bucketSec, rows });
}));

app.get('/api/predictions', asyncRoute(async (req, res) => {
  const dev = await resolveDevice(req);
  if (!dev) return res.json([]);
  const { since, until } = chartRange(req.query);
  const [rows] = await pool.query(
    'SELECT target_time, predicted_temp, model_name, fan_command FROM predictions WHERE device_id = ? AND target_time >= ? AND target_time <= ? ORDER BY target_time ASC LIMIT 20000',
    [dev, since, until]
  );
  res.json(rows);
}));

app.get('/api/events', asyncRoute(async (req, res) => {
  const dev = await resolveDevice(req);
  if (!dev) return res.json([]);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const [rows] = await pool.query(
    'SELECT recorded_at, mode, actuator, state, reason FROM actuator_events WHERE device_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?',
    [dev, limit]
  );
  res.json(rows);
}));

app.get('/api/stats', asyncRoute(async (req, res) => {
  const dev = await resolveDevice(req);
  if (!dev) return res.json({ device_id: null, modes: [] });
  const [modes] = await pool.query(
    `SELECT mode, COUNT(*) AS records, MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at,
            SUM(temperature IS NULL) AS missing_dht, SUM(feed_event) AS feeds
     FROM telemetry WHERE device_id = ? GROUP BY mode`, [dev]
  );
  res.json({ device_id: dev, modes });
}));

// ---- dashboard -> ESP32 (feeding manual)
app.post('/api/commands', express.json({ limit: '1kb' }), asyncRoute(async (req, res) => {
  const dev = deviceId((req.body || {}).device_id);
  const command = oneOf(req.body, 'command', ['feed']);
  const [[pending]] = await pool.query(
    "SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND command = ? AND status = 'pending'", [dev, command]
  );
  if (pending.n > 0) return res.status(409).json({ error: 'Masih ada perintah feeding yang menunggu dikirim ke ESP32' });
  await pool.query('INSERT INTO commands (device_id, command, created_at) VALUES (?, ?, ?)', [dev, command, new Date()]);
  res.status(201).json({ ok: true });
}));

// ---- ML script -> server (AOL)
app.post('/api/predictions', express.json({ limit: '4kb' }), requireKey(ML_API_KEY), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const base = new Date(b.base_time);
  if (Number.isNaN(base.getTime())) throw new ValidationError('base_time harus ISO datetime');
  const horizon = num(b, 'horizon_sec', 1, 86400, { integer: true });
  const row = {
    device_id: deviceId(b.device_id),
    telemetry_id: num(b, 'telemetry_id', 1, Number.MAX_SAFE_INTEGER, { nullable: true, integer: true }),
    base_time: base,
    target_time: new Date(base.getTime() + horizon * 1000),
    predicted_temp: num(b, 'predicted_temp', -20, 80),
    confidence: num(b, 'confidence', 0, 1, { nullable: true }),
    model_name: typeof b.model_name === 'string' && b.model_name.length <= 64 ? b.model_name : (() => { throw new ValidationError('model_name wajib (maks 64 karakter)'); })(),
    fan_command: flag(b, 'fan_command', { nullable: true }),
    created_at: new Date(),
  };
  const [ins] = await pool.query('INSERT INTO predictions SET ?', [row]);
  res.status(201).json({ ok: true, id: ins.insertId });
}));

// ---- export dataset
const DATASET_COLUMNS = [
  ['id', 'id', 8],
  ['timestamp_wib', 'timestamp_wib', 20],
  ['timestamp_utc', 'timestamp_utc', 26],
  ['hour_wib', 'hour_wib', 9],
  ['device_id', 'device_id', 12],
  ['mode', 'mode', 7],
  ['slot_sec', 'slot_sec', 8],
  ['temperature', 'temperature', 11],
  ['humidity', 'humidity', 10],
  ['ldr_raw', 'ldr_raw', 9],
  ['light_pct', 'light_pct', 9],
  ['active_sec', 'active_sec', 10],
  ['pir_ready', 'pir_ready', 9],
  ['inactivity_status', 'inactivity_status', 16],
  ['idle_sec', 'idle_sec', 9],
  ['fan_state', 'fan_state', 9],
  ['fan_by_temp', 'fan_by_temp', 11],
  ['fan_by_hum', 'fan_by_hum', 11],
  ['red_led', 'red_led', 8],
  ['white_led', 'white_led', 10],
  ['is_daytime', 'is_daytime', 10],
  ['feed_event', 'feed_event', 10],
  ['feed_reason', 'feed_reason', 11],
  ['feeds_in_period', 'feeds_in_period', 14],
];

// Label kelas (supervised), dihitung saat export dari data sensor.
// Ambang dipilih dari sebaran dataset 03-11-2026 (sekitar median) supaya tiap kelas punya 2 nilai,
// dan sejak 04-11-2026 dipakai juga oleh firmware (harus sama dengan firmware/src/main.cpp).
// fan_label & red_led_label = simulasi rule kipas/LED dengan ambang ini (hysteresis), sehingga dataset lama
// (direkam dengan ambang 29,5/27,5 °C, 61/58,5 %RH) tetap punya label yang konsisten; status asli ada di fan_state / red_led.
const LABEL_TH = {
  tempHot: 30, tempHotOff: 28.5,     // panas jika > 30 °C; kipas OFF jika < 28,5 °C
  rhHigh: 66, rhHighOff: 64,         // tinggi jika > 66 %RH; LED merah OFF jika < 64 %RH
  ldrDark: 3600,                     // gelap jika LDR > 3600 (sama dengan firmware)
  activeSec: 5,                      // menit aktif jika active_sec > 5 (sama dengan firmware)
};
// Aturan feeding firmware (mode final), dipakai untuk mensimulasikan feeder_label
const FEED_RULE = {
  windowMs: 20 * 60 * 1000, minActive: 10,   // >= 10 dari 20 menit terakhir aktif
  maxPerDay: 2, cooldownMs: 3 * 3600 * 1000, fallbackMs: 24 * 3600 * 1000,
};
const RESET_GAP_MS = 10 * 60 * 1000; // celah > 10 menit (ESP32 restart) -> simulasi aktuator mulai dari OFF

const tempClass = (r) => (r.temperature === null ? null : r.temperature > LABEL_TH.tempHot ? 'panas' : 'normal');
const humClass = (r) => (r.humidity === null ? null : r.humidity > LABEL_TH.rhHigh ? 'tinggi' : 'normal');
const lightClass = (r) => (r.ldr_raw === null ? null : r.ldr_raw > LABEL_TH.ldrDark ? 'gelap' : 'terang');
const onOff = (v) => (v ? 'nyala' : 'mati');

const LABEL_COLUMNS = [
  ['temp_class', 'temp_class', 11],
  ['hum_class', 'hum_class', 10],
  ['light_class', 'light_class', 11],
  ['activity_class', 'activity_class', 13],
  ['active_min_20', 'active_min_20', 13],
  ['fan_label', 'fan_label', 10],
  ['red_led_label', 'red_led_label', 13],
  ['white_led_label', 'white_led_label', 15],
  ['feeder_label', 'feeder_label', 13],
];

/** Label per baris. rows harus urut waktu (simulasi hysteresis butuh status baris sebelumnya). */
function addLabels(rows) {
  let hot = false, humid = false, prevMs = null;
  let sessionStart = null, window = [], feeds = [];   // simulasi feeder (seperti firmware)
  for (const r of rows) {
    const ms = r.recorded_at.getTime();
    if (prevMs === null || ms - prevMs > RESET_GAP_MS) {   // ESP32 (re)start
      hot = false; humid = false; window = []; sessionStart = ms;
    }
    prevMs = ms;
    if (r.temperature !== null) {
      if (!hot && r.temperature > LABEL_TH.tempHot) hot = true;
      if (hot && r.temperature < LABEL_TH.tempHotOff) hot = false;
    }
    if (r.humidity !== null) {
      if (!humid && r.humidity > LABEL_TH.rhHigh) humid = true;
      if (humid && r.humidity < LABEL_TH.rhHighOff) humid = false;
    }
    r.temp_class = tempClass(r);
    r.hum_class = humClass(r);
    r.light_class = lightClass(r);
    // Aktivitas dinilai per menit seperti firmware, berlaku untuk record 1 menit maupun 1-2 detik
    window.push({ ms, sec: r.active_sec });
    window = window.filter((w) => ms - w.ms < FEED_RULE.windowMs);
    const lastMinuteSec = window.filter((w) => ms - w.ms < 60000).reduce((n, w) => n + w.sec, 0);
    const perMinute = {};
    for (const w of window) perMinute[Math.floor(w.ms / 60000)] = (perMinute[Math.floor(w.ms / 60000)] || 0) + w.sec;
    r.activity_class = lastMinuteSec > LABEL_TH.activeSec ? 'aktif' : 'diam';
    r.active_min_20 = Object.values(perMinute).filter((sec) => sec > LABEL_TH.activeSec).length;
    r.fan_label = onOff(hot || humid);
    r.red_led_label = onOff(humid);
    r.white_led_label = onOff(r.white_led);
    r.feeder_label = simulateFeed(ms, r.active_min_20, feeds, sessionStart) ? 'diberi_makan' : 'tidak';
  }
}

/** Rule feeding firmware: kuota 2x/24 jam -> fallback 24 jam -> cooldown 3 jam -> aktivitas. */
function simulateFeed(ms, activeMin, feeds, sessionStart) {
  if (feeds.filter((f) => ms - f < 24 * 3600 * 1000).length >= FEED_RULE.maxPerDay) return false;
  const last = feeds.length ? feeds[feeds.length - 1] : null;
  const fed = (ms - (last ?? sessionStart) >= FEED_RULE.fallbackMs)
    || ((!last || ms - last >= FEED_RULE.cooldownMs) && activeMin >= FEED_RULE.minActive);
  if (fed) feeds.push(ms);
  return fed;
}

/** Cari record pada (t + horizon) untuk target ML. Dicari berdasarkan waktu, bukan urutan baris,
 *  supaya data yang bolong (ESP32 offline) tidak menghasilkan target yang salah. */
function addFuture(rows, horizonMs) {
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const target = rows[i].recorded_at.getTime() + horizonMs;
    const tol = (rows[i].slot_sec * 1000) / 2;
    if (j < i) j = i;
    while (j < rows.length && rows[j].recorded_at.getTime() < target - tol) j++;
    rows[i].future =
      j < rows.length && Math.abs(rows[j].recorded_at.getTime() - target) <= tol ? rows[j] : null;
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/export', asyncRoute(async (req, res) => {
  const dev = await resolveDevice(req);
  if (!dev) return res.status(404).json({ error: 'Belum ada data' });
  const format = oneOf(req.query, 'format', ['xlsx', 'csv']);
  const mode = oneOf({ mode: req.query.mode || 'final' }, 'mode', ['test', 'final']);
  const from = parseDateWIB(req.query.from, false);
  const to = parseDateWIB(req.query.to, true);
  const horizonSec = num({ h: req.query.horizon_sec || 300 }, 'h', 1, 86400, { integer: true });

  const params = [dev, mode];
  let where = 'device_id = ? AND mode = ?';
  if (from) { where += ' AND recorded_at >= ?'; params.push(from); }
  if (to) { where += ' AND recorded_at <= ?'; params.push(to); }

  const [rows] = await pool.query(`SELECT * FROM telemetry WHERE ${where} ORDER BY recorded_at ASC, id ASC`, params);
  addLabels(rows);
  addFuture(rows, horizonSec * 1000);

  const suffix = `t_plus_${horizonSec % 60 === 0 ? `${horizonSec / 60}min` : `${horizonSec}s`}`;
  const targetKey = `temp_${suffix}`;
  const tempClassKey = `temp_class_${suffix}`;
  const fanKey = `fan_${suffix}`;
  const data = rows.map((r) => {
    const wib = toWIB(r.recorded_at);
    const f = r.future;
    return {
      ...r,
      timestamp_wib: wib,
      timestamp_utc: r.recorded_at.toISOString(),
      hour_wib: Number(wib.slice(11, 13)),
      [targetKey]: f ? f.temperature : null,
      [tempClassKey]: f ? f.temp_class : null,
      [fanKey]: f ? f.fan_label : null,
    };
  });
  const columns = [
    ...DATASET_COLUMNS,
    ...LABEL_COLUMNS,
    [targetKey, targetKey, 16],
    [tempClassKey, tempClassKey, 22],
    [fanKey, fanKey, 16],
  ];
  const stamp = `${mode}_${req.query.from || 'all'}_${req.query.to || 'now'}`;

  if (format === 'csv') {
    const lines = [columns.map((c) => c[0]).join(',')];
    for (const r of data) lines.push(columns.map((c) => csvCell(r[c[1]])).join(','));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hamster_dataset_${stamp}.csv"`,
    });
    return res.send(lines.join('\n'));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Smart Hamster Cage';
  wb.created = new Date();

  const ws = wb.addWorksheet('dataset', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  ws.addRows(data);
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const evParams = [dev, mode];
  let evWhere = 'device_id = ? AND mode = ?';
  if (from) { evWhere += ' AND recorded_at >= ?'; evParams.push(from); }
  if (to) { evWhere += ' AND recorded_at <= ?'; evParams.push(to); }
  const [events] = await pool.query(`SELECT * FROM actuator_events WHERE ${evWhere} ORDER BY recorded_at ASC`, evParams);
  const we = wb.addWorksheet('actuator_events', { views: [{ state: 'frozen', ySplit: 1 }] });
  we.columns = [
    { header: 'timestamp_wib', key: 'ts', width: 20 },
    { header: 'actuator', key: 'actuator', width: 12 },
    { header: 'state', key: 'state', width: 10 },
    { header: 'reason', key: 'reason', width: 18 },
  ];
  we.addRows(events.map((e) => ({ ts: toWIB(e.recorded_at), actuator: e.actuator, state: e.state, reason: e.reason })));
  we.getRow(1).font = { bold: true };

  const pParams = [dev];
  let pWhere = 'device_id = ?';
  if (from) { pWhere += ' AND target_time >= ?'; pParams.push(from); }
  if (to) { pWhere += ' AND target_time <= ?'; pParams.push(to); }
  const [preds] = await pool.query(`SELECT * FROM predictions WHERE ${pWhere} ORDER BY target_time ASC`, pParams);
  const wp = wb.addWorksheet('predictions', { views: [{ state: 'frozen', ySplit: 1 }] });
  wp.columns = [
    { header: 'base_time_wib', key: 'base', width: 20 },
    { header: 'target_time_wib', key: 'target', width: 20 },
    { header: 'predicted_temp', key: 'predicted_temp', width: 14 },
    { header: 'confidence', key: 'confidence', width: 11 },
    { header: 'model_name', key: 'model_name', width: 20 },
    { header: 'fan_command', key: 'fan_command', width: 12 },
  ];
  wp.addRows(preds.map((p) => ({ ...p, base: toWIB(p.base_time), target: toWIB(p.target_time) })));
  wp.getRow(1).font = { bold: true };

  const wi = wb.addWorksheet('info');
  wi.columns = [{ header: 'item', key: 'k', width: 22 }, { header: 'value', key: 'v', width: 80 }];
  wi.addRows([
    { k: 'device_id', v: dev },
    { k: 'mode', v: mode },
    { k: 'range (WIB)', v: `${req.query.from || 'awal'} s/d ${req.query.to || 'sekarang'}` },
    { k: 'records', v: data.length },
    { k: 'target regresi', v: `${targetKey} = suhu pada t + ${horizonSec} detik (dicocokkan berdasarkan waktu, toleransi ½ slot). Kosong jika data tidak tersedia.` },
    { k: 'target klasifikasi', v: `${tempClassKey} = kelas suhu (panas/normal) pada t + ${horizonSec} detik; ${fanKey} = status kipas (nyala/mati) pada t + ${horizonSec} detik.` },
    { k: 'ambang label', v: 'Dipilih dari sebaran dataset 03-11-2026 (sekitar median) supaya tiap kelas punya 2 nilai. Dataset 03-11 direkam dengan ambang alat 29,5/27,5 °C dan 61/58,5 %RH; sejak 04-11 firmware memakai ambang yang sama dengan label.' },
    { k: 'temp_class', v: `panas jika temperature > ${LABEL_TH.tempHot} °C, selain itu normal` },
    { k: 'hum_class', v: `tinggi jika humidity > ${LABEL_TH.rhHigh} %RH, selain itu normal` },
    { k: 'light_class', v: `gelap jika ldr_raw > ${LABEL_TH.ldrDark}, selain itu terang (rata-rata 1 menit; LED putih memakai bacaan per 1 detik + hysteresis, jadi bisa sedikit berbeda)` },
    { k: 'activity_class', v: `aktif jika total active_sec dalam 60 detik terakhir > ${LABEL_TH.activeSec} detik (sama dengan firmware), selain itu diam` },
    { k: 'active_min_20', v: 'jumlah menit aktif dalam 20 menit terakhir (syarat feeding: >= 10)' },
    { k: 'fan_label', v: `SIMULASI rule kipas dengan ambang label: nyala jika suhu > ${LABEL_TH.tempHot} °C (mati < ${LABEL_TH.tempHotOff} °C) ATAU RH > ${LABEL_TH.rhHigh} % (mati < ${LABEL_TH.rhHighOff} %). Status relay asli ada di fan_state.` },
    { k: 'red_led_label', v: `SIMULASI rule LED merah: nyala jika RH > ${LABEL_TH.rhHigh} % (mati < ${LABEL_TH.rhHighOff} %). Status LED asli ada di red_led.` },
    { k: 'white_led_label', v: 'Status LED putih asli dari ESP32 (nyala/mati di akhir slot)' },
    { k: 'feeder_label', v: 'SIMULASI rule feeding firmware: maks. 2x/24 jam, fallback 24 jam, jeda 3 jam, >= 10 dari 20 menit aktif. Feeding asli ada di feed_event.' },
    { k: 'catatan ML', v: 'Label di baris yang sama dihitung dari sensor di baris itu (rule-based). Jangan jadikan target bersama fiturnya sendiri (label leakage). Pakai kolom *_t_plus_* sebagai target.' },
    { k: 'ldr_raw', v: 'ADC 0-4095, makin tinggi = makin gelap. light_pct = (4095 - ldr_raw) / 4095 * 100' },
    { k: 'active_sec', v: 'Jumlah detik PIR HIGH dalam satu record (slot_sec detik)' },
    { k: 'nilai sensor', v: 'slot_sec = panjang 1 record (1 detik: LDR/PIR tiap detik, DHT22 tiap 2 detik; 60 detik pada dataset 03-11: rata-rata 1 menit)' },
    { k: 'exported_at (WIB)', v: toWIB(new Date()) },
  ]);
  wi.getRow(1).font = { bold: true };

  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="hamster_dataset_${stamp}.xlsx"`,
  });
  await wb.xlsx.write(res);
  res.end();
}));

// ---------------------------------------------------------------- errors & start
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON tidak valid' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload terlalu besar' });
  console.error('[error]', err);
  res.status(500).json({ error: 'internal error' });
});

(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('[db] Gagal konek ke MySQL:', err.code || err.message);
    process.exit(1);
  }
  app.listen(PORT, HOST, () => console.log(`[server] Dashboard: http://localhost:${PORT}  (listen ${HOST}:${PORT})`));
})();
