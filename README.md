# Smart Hamster Cage

An IoT system that monitors a hamster cage and takes care of it automatically. An ESP32 reads the temperature, humidity, light and hamster movement in the cage, switches a fan and two lights on or off, and feeds the hamster when it is active. All readings are shown on a live web dashboard and stored in a database, so they can be analysed later or used to train a machine-learning model.

## Features

- **Live monitoring.** Temperature, humidity, light level and hamster activity, updated every second.
- **Automatic climate control.** The exhaust fan turns on when the cage is too hot or too humid. A red LED warns when the humidity is high.
- **Automatic lighting.** A white LED lights the cage when the room gets dark.
- **Activity-based feeding.** A servo opens the food flap when the hamster has been active, at most twice a day, with a 3-hour break between meals. If the hamster has not been fed for 24 hours, it is fed anyway.
- **Manual feeding.** A "feed now" button on the dashboard.
- **Inactivity alert.** The dashboard shows a warning when no movement is detected for 4 hours, and a critical alert after 12 hours.
- **History and logs.** Charts of past readings and a log of every time an actuator turns on or off.
- **Dataset export.** Download the stored data as an Excel or CSV file, including labels for machine learning.

## How it works

```
 ┌────────────────────┐   Wi-Fi (HTTP + JSON)   ┌──────────────────────┐      ┌──────────────┐
 │       ESP32        │ ──────────────────────► │   Node.js server     │ ───► │    MySQL     │
 │ sensors + rules    │ ◄────────────────────── │   (Express)          │      │   database   │
 │ fan, LEDs, feeder  │   commands (feed now)   └──────────┬───────────┘      └──────────────┘
 └────────────────────┘                                    │
                                                           ▼
                                              Web dashboard in the browser
```

- The ESP32 makes all automation decisions itself, so the cage keeps working even if the server is offline.
- Every second it sends the latest readings to the server for the live dashboard.
- Every minute it sends one summary record (average readings, active seconds, actuator states). This record is stored in the database and used for the dataset.
- Every time an actuator changes state, the change is logged.

## Hardware

| Component | Purpose | ESP32 pin |
|---|---|---|
| ESP32 DevKit | Microcontroller with Wi-Fi | – |
| DHT22 | Temperature and humidity | GPIO 4 |
| LDR module (analog output) | Light level | GPIO 34 |
| PIR motion sensor (HC-SR501) | Hamster movement | GPIO 27 |
| Relay module + exhaust fan | Ventilation | GPIO 17 (relay is active LOW) |
| Red LED + resistor | High-humidity indicator | GPIO 16 |
| White LED + resistor | Cage light | GPIO 18 |
| SG90 servo | Opens the food flap | GPIO 21 |

The DHT22 and the LDR are powered from 3.3 V. The PIR, the relay and the servo are powered from 5 V (VIN). The fan has its own power supply, which the relay switches on and off. All grounds are connected together.

**Tip:** if the ESP32 restarts when the servo moves, power the servo from a separate 5 V supply. Keep its ground connected to the ESP32 ground.

## Automation rules

| Actuator | Turns ON when | Turns OFF when |
|---|---|---|
| Exhaust fan | temperature > 30 °C **or** humidity > 66 % | temperature < 28.5 °C **and** humidity < 64 % |
| Red LED | humidity > 66 % | humidity < 64 % |
| White LED | it is dark (LDR > 3600) | it is bright (LDR < 3000) |

The gap between the ON and OFF values stops the actuators from switching on and off repeatedly when a reading stays near the limit.

The feeder is checked once a minute. A minute counts as "active" when the PIR detects motion for more than 5 seconds. The rules are checked in this order:

1. If there were already 2 feeds in the last 24 hours, do not feed.
2. If there was no feed for 24 hours, feed.
3. If the last feed was less than 3 hours ago, do not feed.
4. If at least 10 of the last 20 minutes were active, feed.

## Getting started

### What you need

- The hardware listed above, wired as shown in the table.
- A computer on the same Wi-Fi network as the ESP32.
- [Node.js](https://nodejs.org/) 18 or newer.
- MySQL 8 or MariaDB 10.4+. [XAMPP](https://www.apachefriends.org/) is an easy way to get MariaDB on Windows or macOS.
- [VS Code](https://code.visualstudio.com/) with the [PlatformIO](https://platformio.org/install/ide?install=vscode) extension, to upload the firmware.
- A **2.4 GHz** Wi-Fi network. The ESP32 does not support 5 GHz.

### 1. Set up the database

Start MySQL, then create the database and its tables:

```bash
mysql -u root -p < server/db/schema.sql
```

Create a user for the app (replace `your-password`):

```sql
CREATE USER 'hamster_app'@'localhost' IDENTIFIED BY 'your-password';
CREATE USER 'hamster_app'@'127.0.0.1' IDENTIFIED BY 'your-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON hamster_iot.* TO 'hamster_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON hamster_iot.* TO 'hamster_app'@'127.0.0.1';
```

### 2. Start the server

```bash
cd server
cp .env.example .env
npm install
```

Open `server/.env` and fill in these values:

- `DB_PASSWORD`: the password you chose above.
- `DEVICE_API_KEY`: a secret key that the ESP32 uses to send data.
- `ML_API_KEY`: a secret key for sending machine-learning predictions (optional).

You can generate a random key with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then start the server:

```bash
npm start
```

The dashboard is now available at `http://localhost:3000`. Other devices on the same network can open it at `http://<your-computer-ip>:3000`.

### 3. Upload the firmware to the ESP32

1. Open the `firmware` folder in VS Code with PlatformIO.
2. Copy `include/secrets.example.h` to `include/secrets.h` and fill in:
   - `WIFI_SSID` and `WIFI_PASSWORD`: your 2.4 GHz Wi-Fi.
   - `SERVER_URL`: `http://<your-computer-ip>:3000/api/telemetry`.
   - `DEVICE_API_KEY`: the same key as in `server/.env`.
3. If your ESP32 uses a different USB port, change `upload_port` and `monitor_port` in `platformio.ini`.
4. Click **Upload**, then open the **Serial Monitor**. You should see the ESP32 connect to Wi-Fi and print a summary every minute.

The PIR sensor needs about 60 seconds to warm up after power-on. The dashboard shows "WARMUP" during this time.

### 4. Use the dashboard

Open the dashboard in a browser. You will see:

- **Sensor cards:** live temperature, humidity, light, activity and the hamster's status.
- **Actuator cards:** whether the fan, LEDs and feeder are on, and why. The **Beri makan sekarang** (feed now) button feeds the hamster immediately.
- **Charts:** history of the readings over a time range you choose.
- **Actuator log:** every time an actuator turned on or off.
- **Dataset & Export:** the number of stored records, and buttons to download the data as Excel or CSV.

## Project structure

```
├── firmware/                  ESP32 code (PlatformIO)
│   ├── platformio.ini         board and library settings
│   ├── include/
│   │   └── secrets.example.h  Wi-Fi and server settings (copy to secrets.h)
│   └── src/main.cpp           sensors, automation rules, feeding, data sending
└── server/                    web server and dashboard (Node.js)
    ├── server.js              API, database access, dataset export
    ├── db/schema.sql          database tables
    ├── public/                dashboard (HTML, CSS, JavaScript)
    ├── package.json           dependencies
    └── .env.example           server settings (copy to .env)
```

## Exported dataset

Each row of the export is one minute of data. It contains:

- the timestamp;
- the sensor values (temperature, humidity, light and active seconds);
- the actuator states;
- label columns for supervised machine learning, for example whether it was hot, humid or dark.

It also includes target columns five minutes ahead (`temp_t_plus_5min`, `temp_class_t_plus_5min`, `fan_t_plus_5min`). These can be used to train a model that predicts the temperature and the fan state.

## Notes

- The dashboard has no login. Run it only on a private local network, and do not expose it to the internet.
- `secrets.h` and `.env` contain passwords and keys. They are excluded from Git and must never be shared.
- If the Wi-Fi connection drops, the minute without connection is not stored. The automation on the ESP32 keeps running.

---

Developed as a project for the Intelligent Internet of Things course at BINUS University.
