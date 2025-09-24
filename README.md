Airchase Live – README
========================

Stream live GPS + weather from an in‑car **edge** PC and view it in a browser/tablet using **MQTT** over WebSockets.
This doc covers the demo stack: publisher simulator, Mosquitto broker, and the browser UI with widgets + map.

---

Introduction
------------
This project demonstrates a small, practical telemetry pipeline:

- An **edge** process publishes vehicle position + weather and a second “AC2” aircraft position.
- A **Mosquitto** broker fans out topics and exposes WebSockets for browsers.
- A **browser UI** (single-page, static hosting) subscribes to a single fused topic and renders live widgets
  (speed, heading, wind, temperature, altimeter bars) plus a Leaflet map and raw JSON logs.

It’s intended as a starting point you can replace piece‑by‑piece with real data sources,
TLS/auth, and more sophisticated widgets.

Architecture
------------

    [Edge PC: simulator.py]  --MQTT/TCP:1883-->  [Mosquitto Broker]
                                                └─ MQTT over WebSockets :8083 --> [Browser UI: index.html]
                 (vehicle pos+weather, AC2 pos, fused object)                     (widgets + raw JSON log)

- **Edge (simulator.py)**: Publishes fake **vehicle** position/weather and **AC2** position.
  Also publishes a **fused** JSON so the UI subscribes once.
- **Broker (Mosquitto)**: Routes MQTT topics; exposes **TCP 1883** for Python and **WebSockets 8083** for browsers.
- **Frontend (index.html)**: Subscribes over **MQTT/WebSockets**, renders widgets, and shows a raw message log.

Why MQTT (vs UDP)
-----------------
- Works in browsers (UDP doesn’t).
- Built‑in **QoS**, **retained last value**, and **pub/sub** for two‑way control.
- Easy to add **TLS/auth** and topic **ACLs** later.
- Good tooling (Mosquitto, paho‑mqtt, mqtt.js).

Getting Started
---------------

### 1) Install prerequisites
- Docker (or Docker Desktop) for the broker
- Python 3.9+ for the simulator/subscriber (`pip install -r edge/requirements.txt`)
- Any static server for the UI (`python -m http.server` is fine)

### 2) Start the broker

Open a terminal in `broker/`:
```
docker compose up -d
```

Useful broker commands:
```
# See it running
docker compose ps

# Tail the broker logs
docker compose logs -f

# Prove your config is mounted in the container
docker exec -it broker-mosquitto-1 sh -c 'cat /mosquitto/config/mosquitto.conf'

# Restart after editing mosquitto.conf
docker compose restart

# Stop and remove (container, network, but not the named volume)
docker compose down
```

### 3) Run the simulator (edge)

Open a terminal in `edge/`:
```
python simulator.py --broker localhost --rate 2 --vehicle van-1
```
- `--rate` is messages/second (e.g., 2 Hz).
- Replace `van-1` with your vehicle name when integrating with real sources.

### 4) (Optional) Debug subscriber

Open another terminal in `edge/`:
```
python subscriber.py --broker localhost --vehicle van-1 --all
```

### 5) Start the UI

Open a terminal in `ui/`:
```
python3 -m http.server 8001
```
Then browse to: `http://localhost:8001/`

**Tip:** You can override the UI’s runtime config via URL params:
```
http://localhost:8001/?host=localhost&wsport=8083&vehicle=van-1
```
Or edit `ui/config.js`:
```js
window.AIRCHASE_CONFIG = { host: 'localhost', wsPort: 8083, vehicle: 'van-1' };
```

Build and Test
--------------
There’s no build step for the UI (vanilla HTML/CSS/JS). To test end‑to‑end:
1. Start broker (Docker).
2. Start simulator (Python).
3. Start static server for the UI.
4. Watch values animate in the browser and inspect the raw JSON log overlay.

UI Overview
-----------
- **Header controls**: Connect/Disconnect, Logs, animation mode, aggregation (Normal/Avg/EMA),
  unit toggles (speed, temperature, altitude), and theme (Light/Dark).
- **Pace Vehicle / AC2 cards**: Speed (gauge), Heading (compass), Altitude (bar), Latitude/Longitude.
- **Weather card**: Temperature, Wind speed (gauge), Wind direction (compass).
- **Map**: Leaflet map with vehicle and AC2 markers, path trails, and auto fit.

Aggregation & Animation
-----------------------
- **Aggregation** (`Agg` button): *Normal* (latest), *Avg (10s window)*, *EMA (10s time‑constant)*.
  Applies to all displayed values (including compass angles, computed as circular mean/EMA).
- **Animation** (`Anim` button): *Soft* (ease‑out), *Snappy*, *Linear*, or *Off*.
  Affects number tweening, compass needles, map marker rotation/movement, and gauge needles.

Topics
------
- `airchase/<vehicle>/telemetry/pos`
- `airchase/<vehicle>/telemetry/weather`
- `airchase/ac2/telemetry/pos`
- `airchase/fused/<vehicle>`  ← **single combined object** for the UI

Example fused payload
---------------------
```json
{
  "vehicle": {
    "pos": {
      "ts": "2025-09-19T12:58:43.799323Z",
      "lat": 51.51333, "lon": -0.092051, "alt_m": 121.4,
      "spd_mps": 22.66, "hdg_deg": 41.7
    },
    "weather": {
      "ts": "2025-09-19T12:58:43.799323Z",
      "temp_c": 19.8, "rh_pct": 48.2, "pres_hpa": 1013.9,
      "wind_mps": 8.3, "wind_dir_deg": 192
    },
    "derived": {
      "avg":      { "spd_mps": 21.1, "temp_c": 19.7, "wind_mps": 8.0 },
      "filtered": { "spd_mps": 21.2, "temp_c": 19.7, "wind_mps": 8.1 }
    }
  },
  "ac2": { "pos": { "ts": "…", "lat": 51.6, "lon": -0.2, "alt_m": 1511.2, "spd_mps": 72.1, "hdg_deg": 248.0 } }
}
```

Notes & Tips
------------
- **paho‑mqtt 2.x warning**: keep v1 callbacks if you’re following older examples:
```python
import paho.mqtt.client as mqtt
cli = mqtt.Client(
    client_id="subscriber-demo",
    protocol=mqtt.MQTTv311,
    transport="tcp",
    callback_api_version=mqtt.CallbackAPIVersion.VERSION1,
)
```
- **Retained messages**: Consider retaining status topics for instant UI state. (The fused stream in this demo is not retained.)
- **Security (next step)**: disable anonymous access, add user/pass, enable TLS (`mqtts`/`wss`), and set topic ACLs.
- **Payloads**: For higher rates, consider CBOR/Protobuf. Keep the browser on a single “fused” topic to minimize subscriptions.

Troubleshooting
---------------
- **Python `ConnectionRefusedError`**: Broker not listening. Check:
```
cd broker
docker compose ps
docker compose logs -f
docker exec -it broker-mosquitto-1 sh -c 'cat /mosquitto/config/mosquitto.conf'
```
- **Browser won’t connect**: Confirm logs show “Opening websockets listen socket on port 8083” and you’re using `ws://HOST:8083/`.
- **WSL file permissions (EACCES)**: If you can’t edit `mosquitto.conf`, fix ownership/perms:
```
sudo chown $USER:$USER mosquitto.conf .
chmod 644 mosquitto.conf
```

Contribute
----------
Ideas and small improvements welcome:
- Movable / resizable widgets
- Custom or auto min/max limits for gauges and altimeters
- TLS/auth + topic ACLs + per‑vehicle namespaces
- Replace simulator with NMEA/serial readers and add sensor health/status topics
- Retain key “last‑known” state topics
- Map enhancements (wind arrow, geofences, basemap selector)

License
-------
Internal prototype; use at your own risk in demo environments.
