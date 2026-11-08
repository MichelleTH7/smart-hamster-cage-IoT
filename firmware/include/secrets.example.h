// Salin file ini menjadi secrets.h (di folder include/) lalu isi nilainya.
// secrets.h sudah ada di .gitignore -> jangan di-commit / dikirim ke orang lain.
#pragma once

#define WIFI_SSID       "<nama-wifi-2.4GHz>"
#define WIFI_PASSWORD   "<password-wifi>"

// IP laptop yang menjalankan server Node.js (cek: System Settings > Wi-Fi > Details, atau `ipconfig getifaddr en0`)
#define SERVER_URL      "http://192.168.1.10:3000/api/telemetry"

// Harus sama dengan DEVICE_API_KEY di server/.env
#define DEVICE_API_KEY  "<isi-random-key>"

#define DEVICE_ID       "hamster-01"
