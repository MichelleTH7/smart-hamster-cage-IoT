/*
 * Smart Hamster Cage - firmware ESP32
 *
 * Sensor   : DHT22 (suhu, kelembapan), LDR (cahaya), PIR HC-SR501 (gerak hamster)
 * Aktuator : relay kipas, LED merah, LED putih, servo feeder
 * Baca     : PIR + LDR tiap 1 detik, DHT22 tiap 2 detik (DHT22 maks. 1x / 2 detik)
 * Kirim    : - live tiap 1 detik ke /api/live (dashboard real-time, tidak disimpan ke dataset)
 *            - 1 record rata-rata tiap 1 menit ke /api/telemetry -> MySQL (dataset untuk ML)
 * Feeding  : rule feeding dicek tiap akhir slot (1 menit). Jumlah menit aktif dan riwayat feeding
 *            diambil dari dataset di server lewat response tiap record (sama dengan dashboard).
 *            Riwayat feeding digabung dengan catatan lokal ESP32 supaya tidak bisa makan berlebih;
 *            saat server tidak terjangkau dipakai hitungan lokal.
 *
 * Semua timing memakai millis() (tanpa delay di loop) supaya sensor, aktuator dan
 * pengiriman data berjalan bersamaan.
 */
#include <Arduino.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD, SERVER_URL, DEVICE_API_KEY, DEVICE_ID

// ================================================================ KONFIGURASI
#define TEST_MODE 0    // 1 = durasi dipersingkat untuk demo, 0 = final (pengambilan data)

// ---- Pin
const int DHT_PIN       = 4;
const int LDR_PIN       = 34;   // ADC1: tetap bisa dibaca saat WiFi aktif
const int PIR_PIN       = 27;
const int RED_LED_PIN   = 16;
const int WHITE_LED_PIN = 18;
const int RELAY_PIN     = 17;   // kipas
const int SERVO_PIN     = 21;   // feeder
const bool RELAY_ACTIVE_LOW = true;

// ---- Ambang aktuator (ON > ambang atas, OFF < ambang bawah = hysteresis)
// Dipilih dari dataset 03-11-2026; sama dengan LABEL_TH di server/server.js
const float TEMP_HOT_ON  = 30.0, TEMP_HOT_OFF  = 28.5;   // °C   -> kipas
const float HUM_HIGH_ON  = 66.0, HUM_HIGH_OFF  = 64.0;   // %RH  -> kipas + LED merah
const float LDR_DARK_ON  = 3600, LDR_DARK_OFF  = 3000;   // ADC  -> LED putih (tinggi = gelap)

// ---- Feeder
const int      SERVO_CLOSED = 180;
const int      SERVO_OPEN   = 135;
const uint32_t FEED_OPEN_MS = 200;       // lama flap terbuka = besar porsi
const int      FEED_MAX     = 2;         // maks. feeding per FEED_PERIOD_MS

// ---- Timing
const uint32_t DHT_INTERVAL_MS    = 2000;      // baca DHT22 (DHT22 maks. 1x / 2 detik)
const uint32_t LIVE_INTERVAL_MS   = 1000;      // baca PIR + LDR + kirim data live
const uint32_t PIR_WARMUP_MS      = 60000;     // HC-SR501 butuh ±60 detik setelah menyala
const uint32_t WIFI_RETRY_MS      = 30000;
const uint16_t HTTP_TIMEOUT_MS    = 800;       // < interval live (1 detik), supaya loop tidak tertahan lama

const uint32_t MINUTE = 60000UL, HOUR = 60 * MINUTE;

#if TEST_MODE
const uint32_t SLOT_MS          = 5000;        // 1 slot = 5 detik
const int      ACTIVE_SEC_MIN   = 2;           // slot aktif jika PIR HIGH >= 2 detik
const int      WINDOW_SLOTS     = 12;
const int      MIN_ACTIVE_SLOTS = 10;
const uint32_t FEED_COOLDOWN_MS = 2 * MINUTE;
const uint32_t FEED_PERIOD_MS   = 10 * MINUTE;
const uint32_t FEED_FALLBACK_MS = 5 * MINUTE;
const uint32_t INACT_WARN_MS    = 30000;
const uint32_t INACT_CRIT_MS    = 60000;
#else
// Angka aktivitas dari dataset 03-11-2026: maks. 12 dari 20 menit aktif (> 5 detik)
const uint32_t SLOT_MS          = MINUTE;      // 1 slot = 1 menit (unit aktivitas & cek feeding)
const int      ACTIVE_SEC_MIN   = 6;           // menit aktif jika PIR HIGH > 5 detik
const int      WINDOW_SLOTS     = 20;          // jendela aktivitas 20 menit terakhir
const int      MIN_ACTIVE_SLOTS = 10;          // feeding jika >= 10 dari 20 menit aktif
const uint32_t FEED_COOLDOWN_MS = 3 * HOUR;    // 2 jatah makan tidak habis dalam 1 sesi aktif
const uint32_t FEED_PERIOD_MS   = 24 * HOUR;
const uint32_t FEED_FALLBACK_MS = 24 * HOUR;   // 24 jam tanpa feeding -> beri makan
const uint32_t INACT_WARN_MS    = 4 * HOUR;
const uint32_t INACT_CRIT_MS    = 12 * HOUR;
#endif

// ================================================================ STATE
// Saklar dengan hysteresis: ON jika nilai > on, OFF jika nilai < off.
// Jarak on-off mencegah aktuator nyala-mati terus karena noise sensor.
struct Hysteresis {
  float on, off;
  bool state;
  Hysteresis(float onAbove, float offBelow) : on(onAbove), off(offBelow), state(false) {}
  bool update(float v) {
    if (!state && v > on) state = true;
    else if (state && v < off) state = false;
    return state;
  }
};

Hysteresis tooHot{TEMP_HOT_ON, TEMP_HOT_OFF};
Hysteresis tooHumid{HUM_HIGH_ON, HUM_HIGH_OFF};
Hysteresis tooDark{LDR_DARK_ON, LDR_DARK_OFF};
bool fanOn = false;
float lastTemp = NAN, lastHum = NAN;    // bacaan DHT22 terakhir (dipakai data live & Serial Monitor)
bool  climateOk = false;               // false = bacaan DHT22 terakhir gagal -> temp/humidity null di data live
int   lastLdr = 0;

DHT dht(DHT_PIN, DHT22);
Servo feeder;

// Aktivitas hamster
bool     pirReady = false;
int      activeSec = 0;                 // detik PIR HIGH di slot berjalan
int      lastActiveSec = 0;             // hasil slot terakhir (dikirim ke dataset)
uint32_t lastMotionMs = 0;
bool     slotActive[WINDOW_SLOTS] = {}; // jendela aktivitas (circular buffer)
int      slotIndex = 0;

// Feeder
bool     feederOpen = false;
uint32_t feedOpenedMs = 0;

// Riwayat feeding (waktu dalam millis())
struct FeedLog {
  uint32_t times[FEED_MAX] = {};        // feeding terbaru, [0] = paling baru
  int      count = 0;
  bool     hasFed = false;
  uint32_t lastMs = 0;

  void add(uint32_t t) {
    for (int i = FEED_MAX - 1; i > 0; i--) times[i] = times[i - 1];
    times[0] = t;
    count = min(count + 1, FEED_MAX);
    hasFed = true;
    lastMs = t;
  }
  int inPeriod(uint32_t now) const {
    int n = 0;
    for (int i = 0; i < count; i++) n += (now - times[i] < FEED_PERIOD_MS);
    return n;
  }
};
FeedLog  localLog;                      // feeding oleh ESP32 ini sejak menyala
FeedLog  dbLog;                         // feeding menurut dataset di server
uint32_t historyStartMs = 0;            // awal riwayat jika belum pernah makan (record pertama / ESP32 menyala)
int      dbActiveMin = -1;              // menit aktif 20 menit terakhir menurut dataset (-1 = tidak ada)
uint32_t lastSyncMs = 0;                // terakhir dapat data dari server
bool     historySynced = false;

// 1 record dataset = ringkasan 1 slot (1 menit): rata-rata sensor, total detik aktif, feeding
struct MinuteRecord {
  float sumTemp = 0, sumHum = 0;
  int   nClimate = 0;                    // jumlah bacaan DHT22 yang berhasil (0 -> temp/humidity null)
  long  sumLdr = 0;
  int   nLdr = 0;
  int   feedEvents = 0;
  char  feedReason[10] = "";
} minuteRec;

// Data live (tiap 1 detik): feeding yang belum sampai ke server dikirim ulang di live berikutnya
int  liveActiveSec = 0;                  // detik PIR HIGH sejak live terakhir
int  liveFeedEvents = 0;
char liveFeedReason[10] = "";

uint32_t lastDhtMs = 0, lastLiveMs = 0, slotStartMs = 0, lastWifiTryMs = 0;
uint32_t sentCount = 0, failCount = 0;   // statistik kirim live per slot (untuk Serial Monitor)

// ================================================================ WAKTU (NTP)
uint32_t nowEpoch() {                    // 0 = jam belum sinkron
  time_t e = time(nullptr);
  return e > 1700000000 ? (uint32_t)e : 0;
}

int daytimeState() {                     // 1 siang (06-18), 0 malam, -1 belum sinkron
  struct tm t;
  if (!getLocalTime(&t, 0)) return -1;
  return (t.tm_hour >= 6 && t.tm_hour < 18) ? 1 : 0;
}

// ================================================================ AKTUATOR LINGKUNGAN
void setRelay(bool on) {
  digitalWrite(RELAY_PIN, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void updateClimate(float temp, float hum) {
  tooHot.update(temp);
  tooHumid.update(hum);
  fanOn = tooHot.state || tooHumid.state;          // kipas: panas ATAU lembap
  setRelay(fanOn);
  digitalWrite(RED_LED_PIN, tooHumid.state);       // LED merah: indikator lembap
}

void updateLight(int ldr) {
  digitalWrite(WHITE_LED_PIN, tooDark.update(ldr)); // LED putih: nyala saat gelap
}

void readClimate() {                     // DHT22, tiap 2 detik
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  climateOk = !isnan(t) && !isnan(h);
  if (!climateOk) {
    Serial.println("DHT22 gagal dibaca");
  } else {
    updateClimate(t, h);
    lastTemp = t;
    lastHum = h;
    minuteRec.sumTemp += t;
    minuteRec.sumHum += h;
    minuteRec.nClimate++;
  }
}

void readLight() {                       // LDR, tiap 1 detik
  lastLdr = analogRead(LDR_PIN);
  minuteRec.sumLdr += lastLdr;
  minuteRec.nLdr++;
  updateLight(lastLdr);
}

// ================================================================ AKTIVITAS HAMSTER (PIR)
void updatePir(uint32_t now) {
  if (!pirReady) {
    if (now < PIR_WARMUP_MS) return;     // abaikan PIR selama warm-up
    pirReady = true;
    lastMotionMs = now;
    Serial.println("PIR siap");
  }
  if (digitalRead(PIR_PIN) == HIGH) {
    activeSec++;
    liveActiveSec++;
    lastMotionMs = now;
  }
}

int countActiveSlots() {
  int n = 0;
  for (bool a : slotActive) n += a;
  return n;
}

const char* inactivityStatus(uint32_t now) {
  if (!pirReady) return "WARMUP";
  uint32_t idle = now - lastMotionMs;
  if (idle >= INACT_CRIT_MS) return "CRITICAL";
  if (idle >= INACT_WARN_MS) return "WARNING";
  return "NORMAL";
}

// ================================================================ FEEDER
// Riwayat lokal dan dataset digabung, dipakai yang paling ketat (kuota terbanyak, feeding
// paling baru): restart ESP32 tidak menghapus riwayat, dan mengosongkan database tidak
// membuat hamster bisa makan lagi berturut-turut.
bool serverFresh(uint32_t now) { return historySynced && now - lastSyncMs < MINUTE; }

int feedsInPeriod(uint32_t now) {
  return max(localLog.inPeriod(now), dbLog.inPeriod(now));
}

bool hasFed() { return localLog.hasFed || dbLog.hasFed; }

uint32_t sinceLastFeed(uint32_t now) {   // belum pernah makan -> dihitung dari awal riwayat
  if (!hasFed()) return now - historyStartMs;
  uint32_t local = localLog.hasFed ? now - localLog.lastMs : UINT32_MAX;
  uint32_t db    = dbLog.hasFed    ? now - dbLog.lastMs    : UINT32_MAX;
  return min(local, db);
}

// Menit aktif untuk syarat feeding: dari dataset (sama dengan dashboard, tidak hilang saat
// restart); hitungan lokal dipakai saat server tidak terjangkau atau di TEST_MODE.
int activeSlotsForFeeding(uint32_t now) {
  if (!TEST_MODE && serverFresh(now) && dbActiveMin >= 0) return dbActiveMin;
  return countActiveSlots();
}

// Data dari server (dihitung dari dataset): umur tiap feeding 24 jam terakhir (terbaru dulu),
// detik sejak feeding terakhir dan menit aktif. Waktu diubah ke millis() relatif
// (selisih uint32_t tetap benar walau hasilnya "sebelum ESP32 menyala").
void syncFromServer(JsonVariantConst f, uint32_t now) {
  if (f.isNull()) return;
  dbLog = FeedLog();
  for (JsonVariantConst age : f["ages_sec"].as<JsonArrayConst>()) {
    if (dbLog.count == FEED_MAX) break;
    dbLog.times[dbLog.count++] = now - age.as<uint32_t>() * 1000UL;
  }
  uint32_t since = f["since_last_sec"] | 0UL;
  dbLog.hasFed = f["has_fed"] | false;
  if (dbLog.hasFed) dbLog.lastMs = now - since * 1000UL;
  else historyStartMs = now - since * 1000UL;
  dbActiveMin = f["active_minutes"] | -1;
  lastSyncMs = now;
  historySynced = true;
}

void startFeeding(uint32_t now, const char* reason) {
  if (feederOpen) return;
  feeder.write(SERVO_OPEN);
  feederOpen = true;
  feedOpenedMs = now;

  localLog.add(now);

  minuteRec.feedEvents++;                // masuk record dataset menit ini
  strlcpy(minuteRec.feedReason, reason, sizeof(minuteRec.feedReason));
  liveFeedEvents++;                      // dicatat server di actuator_events saat itu juga
  strlcpy(liveFeedReason, reason, sizeof(liveFeedReason));
  Serial.printf(">>> Feeder OPEN (%s)\n", reason);
}

void closeFeederWhenDone(uint32_t now) {
  if (feederOpen && now - feedOpenedMs >= FEED_OPEN_MS) {
    feeder.write(SERVO_CLOSED);
    feederOpen = false;
    Serial.println(">>> Feeder CLOSED");
  }
}

// Rule-based feeding, dicek tiap akhir slot (urutan = prioritas)
void checkAutoFeed(uint32_t now) {
  if (feedsInPeriod(now) >= FEED_MAX) return;                   // 1. kuota 2x / 24 jam habis
  if (sinceLastFeed(now) >= FEED_FALLBACK_MS) {                  // 2. 24 jam tanpa makan
    startFeeding(now, "fallback");
    return;
  }
  if (hasFed() && sinceLastFeed(now) < FEED_COOLDOWN_MS) return; // 3. jeda 3 jam
  if (activeSlotsForFeeding(now) >= MIN_ACTIVE_SLOTS) {          // 4. hamster sedang aktif
    startFeeding(now, "activity");
  }
}

// ================================================================ JARINGAN
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[NET] Connecting WiFi");
  for (uint32_t start = millis(); WiFi.status() != WL_CONNECTED && millis() - start < 10000;) {
    delay(250);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED
                 ? "\n[NET] WiFi OK, IP " + WiFi.localIP().toString()
                 : "\n[NET] WiFi gagal, dicoba lagi di loop");
  configTzTime("WIB-7", "pool.ntp.org", "time.google.com");   // jam WIB untuk timestamp
}

void maintainWifi(uint32_t now) {
  if (WiFi.status() == WL_CONNECTED || now - lastWifiTryMs < WIFI_RETRY_MS) return;
  lastWifiTryMs = now;
  Serial.println("[NET] WiFi terputus, reconnect...");
  WiFi.reconnect();
}

float round2(float v) { return roundf(v * 100) / 100; }

// live = true : bacaan terakhir (tiap 1 detik, untuk dashboard; tidak disimpan)
// live = false: record dataset 1 menit (rata-rata sensor, total detik aktif, status aktuator akhir menit)
String buildTelemetry(uint32_t now, bool live) {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["ts"]        = nowEpoch();                     // 0 -> server memakai jamnya sendiri
  doc["mode"]      = TEST_MODE ? "test" : "final";

  if (live) {
    doc["slot_sec"] = LIVE_INTERVAL_MS / 1000;
    if (climateOk) {
      doc["temp"]     = round2(lastTemp);
      doc["humidity"] = round2(lastHum);
    } else {
      doc["temp"]     = nullptr;                     // DHT22 gagal dibaca
      doc["humidity"] = nullptr;
    }
    doc["ldr"]             = lastLdr;
    doc["active_sec"]      = liveActiveSec;
    doc["slot_active_sec"] = activeSec;              // detik aktif di menit yang sedang berjalan
    doc["feed_events"]     = liveFeedEvents;
    if (liveFeedEvents > 0) doc["feed_reason"] = liveFeedReason; else doc["feed_reason"] = nullptr;
  } else {
    const MinuteRecord& m = minuteRec;
    doc["slot_sec"] = SLOT_MS / 1000;                // 60 = 1 record per menit (sama dengan dataset 03-11)
    if (m.nClimate > 0) {
      doc["temp"]     = round2(m.sumTemp / m.nClimate);
      doc["humidity"] = round2(m.sumHum / m.nClimate);
    } else {
      doc["temp"]     = nullptr;                     // DHT22 gagal sepanjang menit ini
      doc["humidity"] = nullptr;
    }
    doc["ldr"]         = m.nLdr > 0 ? (int)lroundf((float)m.sumLdr / m.nLdr) : lastLdr;
    doc["active_sec"]  = lastActiveSec;              // total detik PIR HIGH dalam 1 menit
    doc["feed_events"] = m.feedEvents;
    if (m.feedEvents > 0) doc["feed_reason"] = m.feedReason; else doc["feed_reason"] = nullptr;
  }

  doc["pir_ready"]   = pirReady;
  doc["inactivity"]  = inactivityStatus(now);
  doc["idle_sec"]    = pirReady ? (now - lastMotionMs) / 1000 : 0;
  doc["fan"]         = fanOn;
  doc["fan_by_temp"] = tooHot.state;
  doc["fan_by_hum"]  = tooHumid.state;
  doc["red_led"]     = tooHumid.state;
  doc["white_led"]   = tooDark.state;
  int day = daytimeState();
  if (day < 0) doc["is_daytime"] = nullptr; else doc["is_daytime"] = day;
  doc["feeds_in_period"] = feedsInPeriod(now);

  String body;
  serializeJson(doc, body);
  return body;
}

// POST ke server; mengembalikan body response (kosong jika gagal)
String postJson(const String& url, const String& body) {
  if (WiFi.status() != WL_CONNECTED) {
    failCount++;
    return "";
  }
  // koneksi dipakai ulang (keep-alive) supaya tidak handshake TCP tiap 1 detik (host sama untuk live & record)
  static WiFiClient client;
  static HTTPClient http;
  http.setReuse(true);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(client, url)) {
    failCount++;
    return "";
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", DEVICE_API_KEY);

  String resp;
  int code = http.POST(body);
  if (code == 200) {
    resp = http.getString();
    sentCount++;
  } else {
    failCount++;
    Serial.printf("[NET] POST gagal: %d\n", code);
  }
  http.end();
  return resp;
}

// Response server: riwayat feeding dari dataset + perintah dashboard, mis. {"feed":{...},"commands":["feed"]}
void handleServerResponse(const String& resp, uint32_t now) {
  JsonDocument doc;
  if (resp.isEmpty() || deserializeJson(doc, resp)) return;
  syncFromServer(doc["feed"], now);
  for (JsonVariant c : doc["commands"].as<JsonArray>()) {
    if (c == "feed") startFeeding(now, "manual");
  }
}

// ================================================================ LIVE (tiap 1 detik) & RECORD + SLOT (tiap 1 menit)
const String TELEMETRY_URL = SERVER_URL;                          // .../api/telemetry (disimpan)
const String& liveUrl() {                                         // .../api/live (tidak disimpan)
  static String u;
  if (u.isEmpty()) {
    u = TELEMETRY_URL;
    u.replace("/api/telemetry", "/api/live");
  }
  return u;
}

void sendLive(uint32_t now) {
  String resp = postJson(liveUrl(), buildTelemetry(now, true));
  liveActiveSec = 0;
  if (!resp.isEmpty()) liveFeedEvents = 0;     // gagal kirim: feeding ikut live berikutnya
  handleServerResponse(resp, now);             // perintah dashboard + riwayat feeding
}

void sendMinuteRecord(uint32_t now) {
  String resp = postJson(TELEMETRY_URL, buildTelemetry(now, false));
  MinuteRecord next;
  if (resp.isEmpty() && minuteRec.feedEvents > 0) {  // gagal kirim: feeding ikut record berikutnya
    next.feedEvents = minuteRec.feedEvents;           // supaya tetap ada di dataset (label feeder)
    strlcpy(next.feedReason, minuteRec.feedReason, sizeof(next.feedReason));
  }
  minuteRec = next;
  handleServerResponse(resp, now);             // riwayat feeding & menit aktif termasuk menit ini
}

void closeSlot(uint32_t now) {
  lastActiveSec = activeSec;
  activeSec = 0;
  slotActive[slotIndex] = pirReady && lastActiveSec >= ACTIVE_SEC_MIN;
  slotIndex = (slotIndex + 1) % WINDOW_SLOTS;
  sendMinuteRecord(now);                 // simpan 1 record menit ini, lalu cek feeding dengan data terbaru

  uint32_t since = sinceLastFeed(now);
  Serial.printf("Temp %.1f C | Hum %.1f %% | LDR %d | Fan %s | Red %s | White %s\n",
                lastTemp, lastHum, lastLdr, fanOn ? "ON" : "OFF",
                tooHumid.state ? "ON" : "OFF", tooDark.state ? "ON" : "OFF");
  bool fromDb = !TEST_MODE && serverFresh(now) && dbActiveMin >= 0;
  Serial.printf("Activity %d s | Active %d/%d (%s, butuh %d) | %s | Feeds %d/%d | Fallback dalam %lu menit\n",
                lastActiveSec, activeSlotsForFeeding(now), WINDOW_SLOTS, fromDb ? "dataset" : "lokal",
                MIN_ACTIVE_SLOTS, inactivityStatus(now), feedsInPeriod(now), FEED_MAX,
                since >= FEED_FALLBACK_MS ? 0UL : (unsigned long)((FEED_FALLBACK_MS - since) / MINUTE));
  Serial.printf("[NET] Live terkirim %lu, gagal %lu (1 menit terakhir)\n",
                (unsigned long)sentCount, (unsigned long)failCount);
  sentCount = failCount = 0;

  checkAutoFeed(now);
}

// ================================================================ SETUP & LOOP
void setup() {
  Serial.begin(115200);

  setRelay(false);                       // set OFF sebelum & sesudah pinMode
  pinMode(RELAY_PIN, OUTPUT);            // supaya kipas tidak sempat nyala saat boot
  setRelay(false);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(WHITE_LED_PIN, OUTPUT);
  pinMode(PIR_PIN, INPUT);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(WHITE_LED_PIN, LOW);

  feeder.attach(SERVO_PIN, 500, 2400);   // pulse width SG90 (µs)
  feeder.write(SERVO_CLOSED);

  dht.begin();
  connectWifi();
  delay(2000);                           // DHT22 butuh waktu stabil
  Serial.println("Sistem mulai. PIR warm-up 60 detik. Ketik 'f' untuk feeding manual.");

  slotStartMs = lastLiveMs = lastDhtMs = millis();
}

void loop() {
  uint32_t now = millis();

  maintainWifi(now);
  closeFeederWhenDone(now);
  if (Serial.available() && tolower(Serial.read()) == 'f') startFeeding(now, "manual");

  if (now - lastDhtMs >= DHT_INTERVAL_MS) {        // tiap 2 detik: DHT22 -> kipas & LED merah
    lastDhtMs = now;
    readClimate();
  }
  bool liveDue = now - lastLiveMs >= LIVE_INTERVAL_MS;
  if (liveDue) {                                   // tiap 1 detik: PIR + LDR -> LED putih
    lastLiveMs = now;
    updatePir(now);
    readLight();
  }
  if (now - slotStartMs >= SLOT_MS) {              // tiap 1 menit: simpan record + cek feeding
    slotStartMs += SLOT_MS;
    closeSlot(now);
  }
  if (liveDue) sendLive(now);                      // tiap 1 detik: data live ke dashboard
}
