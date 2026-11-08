-- Smart Hamster Cage - MySQL schema (MySQL 8+ / MariaDB 10.5+)
-- Semua waktu disimpan dalam UTC.

CREATE DATABASE IF NOT EXISTS hamster_iot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE hamster_iot;

-- 1 baris = 1 slot (1 menit di mode final). Ini tabel dataset utama.
CREATE TABLE IF NOT EXISTS telemetry (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id         VARCHAR(32)  NOT NULL,
  recorded_at       DATETIME(3)  NOT NULL,             -- waktu akhir slot (UTC)
  time_source       ENUM('device','server') NOT NULL,  -- device = NTP di ESP32
  mode              ENUM('test','final') NOT NULL,
  slot_sec          SMALLINT UNSIGNED NOT NULL,        -- panjang slot (5 / 60)
  temperature       DECIMAL(5,2) NULL,                 -- rata-rata slot, °C
  humidity          DECIMAL(5,2) NULL,                 -- rata-rata slot, %RH
  ldr_raw           SMALLINT UNSIGNED NULL,            -- rata-rata ADC 0-4095 (tinggi = gelap)
  light_pct         DECIMAL(5,2) NULL,                 -- (4095 - ldr) / 4095 * 100
  active_sec        SMALLINT UNSIGNED NOT NULL,        -- detik PIR HIGH dalam slot
  pir_ready         TINYINT(1) NOT NULL,
  inactivity_status VARCHAR(10) NOT NULL,              -- WARMUP / NORMAL / WARNING / CRITICAL
  idle_sec          INT UNSIGNED NOT NULL,
  fan_state         TINYINT(1) NOT NULL,
  fan_by_temp       TINYINT(1) NOT NULL,
  fan_by_hum        TINYINT(1) NOT NULL,
  red_led           TINYINT(1) NOT NULL,
  white_led        TINYINT(1) NOT NULL,
  is_daytime        TINYINT(1) NULL,
  feed_event        TINYINT UNSIGNED NOT NULL DEFAULT 0, -- jumlah feeding dalam slot
  feed_reason       VARCHAR(10) NULL,                    -- activity / fallback / manual
  feeds_in_period   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_tel_time (recorded_at),
  INDEX idx_tel_dev_mode_time (device_id, mode, recorded_at),
  INDEX idx_tel_feed (device_id, mode, feed_event, recorded_at)   -- riwayat feeding untuk ESP32
) ENGINE=InnoDB;

-- Log aktivitas aktuator (perubahan status).
CREATE TABLE IF NOT EXISTS actuator_events (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id   VARCHAR(32) NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  mode        ENUM('test','final') NOT NULL,
  actuator    VARCHAR(16) NOT NULL,    -- fan / red_led / white_led / feeder / inactivity
  state       VARCHAR(16) NOT NULL,    -- ON / OFF / OPEN / WARNING / ...
  reason      VARCHAR(48) NULL,
  INDEX idx_evt_time (recorded_at),
  INDEX idx_evt_dev_time (device_id, recorded_at),
  INDEX idx_evt_feeder (device_id, mode, actuator, recorded_at)   -- riwayat feeding (kuota, jeda, fallback)
) ENGINE=InnoDB;

-- Perintah dari dashboard ke ESP32 (diambil saat ESP32 mengirim telemetry).
CREATE TABLE IF NOT EXISTS commands (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id  VARCHAR(32) NOT NULL,
  command    VARCHAR(16) NOT NULL,     -- feed
  status     ENUM('pending','sent','expired') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at    DATETIME(3) NULL,
  INDEX idx_cmd_pending (device_id, status, created_at)
) ENGINE=InnoDB;

-- Hasil prediksi ML (AOL): suhu t+5 menit.
CREATE TABLE IF NOT EXISTS predictions (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id      VARCHAR(32) NOT NULL,
  telemetry_id   BIGINT UNSIGNED NULL,
  base_time      DATETIME(3) NOT NULL,   -- waktu data input terakhir
  target_time    DATETIME(3) NOT NULL,   -- waktu yang diprediksi (base + horizon)
  predicted_temp DECIMAL(5,2) NOT NULL,
  confidence     DECIMAL(5,4) NULL,      -- opsional (0-1)
  model_name     VARCHAR(64) NOT NULL,
  fan_command    TINYINT(1) NULL,        -- rekomendasi kipas dari model (AOL)
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_pred_dev_target (device_id, target_time)
) ENGINE=InnoDB;
