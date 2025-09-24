#!/usr/bin/env python3
# edge/simulator.py
import time, json, math, random, argparse
from collections import deque
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

R_EARTH = 6371000.0  # meters


def haversine(lat1, lon1, lat2, lon2):
    from math import radians, sin, cos, atan2
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dl / 2) ** 2
    c = 2 * atan2(math.sqrt(a), math.sqrt(1 - a))
    return R_EARTH * c


def bearing(lat1, lon1, lat2, lon2):
    from math import radians, degrees, sin, cos, atan2
    phi1, phi2 = radians(lat1), radians(lat2)
    dl = radians(lon2 - lon1)
    y = sin(dl) * cos(phi2)
    x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dl)
    brng = (degrees(atan2(y, x)) + 360) % 360
    return brng


class EMA:
    def __init__(self, alpha):
        self.a = alpha
        self.y = None

    def step(self, x):
        self.y = x if self.y is None else self.a * x + (1 - self.a) * self.y
        return self.y


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def main():
    ap = argparse.ArgumentParser(description="Airchase simulator (vehicle + weather + AC2)")
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--vehicle", default="pace_vehicle")
    ap.add_argument("--topic_base", default="airchase")
    ap.add_argument("--rate", type=float, default=10.0, help="publish rate Hz for pos/AC2")
    ap.add_argument("--weather-rate", type=float, default=2.0, help="weather rate Hz")
    ap.add_argument("--qos", type=int, default=0)
    ap.add_argument("--start-lat", type=float, default=51.66)
    ap.add_argument("--start-lon", type=float, default=-2.06)
    ap.add_argument("--emit-fused", action="store_true",
                    help="also publish a fused message (useful without subscriber)")
    args = ap.parse_args()

    # paho v2 API (no deprecation warning)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"sim-{args.vehicle}")
    client.connect(args.broker, args.port, keepalive=30)
    client.loop_start()

    # Initial positions
    v_lat, v_lon = args.start_lat, args.start_lon
    a_lat, a_lon = args.start_lat + 0.01, args.start_lon - 0.01
    v_heading = 90.0
    a_heading = 250.0
    v_alt = 120.0
    a_alt = 1500.0

    # Filters / averages
    ema_temp = EMA(0.2)
    ema_wind = EMA(0.2)
    ema_spd = EMA(0.2)
    winN = 10
    spd_hist, temp_hist, wind_hist = deque(maxlen=winN), deque(maxlen=winN), deque(maxlen=winN)

    # Timers
    period_pos = 1.0 / max(0.001, float(args.rate))
    period_wx = 1.0 / max(0.001, float(args.weather_rate))
    next_pos = time.perf_counter()
    next_wx = next_pos

    try:
        while True:
            now = time.perf_counter()

            # --- POS / AC2 ---
            if now >= next_pos:
                # Vehicle motion ~ 5–35 m/s with small drift; heading slowly meanders
                spd = clamp(13 + random.uniform(-4, 4) + 0.5 * math.sin(now * 0.7), 5.0, 35.0)
                v_heading = (v_heading + random.uniform(-2.5, 2.5)) % 360

                dist = spd * period_pos
                v_lat += (dist * math.cos(math.radians(v_heading))) / R_EARTH * (180 / math.pi)
                v_lon += (dist * math.sin(math.radians(v_heading))) / (
                    R_EARTH * math.cos(math.radians(v_lat))
                ) * (180 / math.pi)
                v_alt += 0.15 * math.sin(now * 0.6)

                # Aircraft
                a_spd = clamp(spd * 2.0 + random.uniform(-3, 3), 20.0, 80.0)
                a_heading = (a_heading + random.uniform(-2, 2)) % 360
                a_dist = a_spd * period_pos
                a_lat += (a_dist * math.cos(math.radians(a_heading))) / R_EARTH * (180 / math.pi)
                a_lon += (a_dist * math.sin(math.radians(a_heading))) / (
                    R_EARTH * math.cos(math.radians(a_lat))
                ) * (180 / math.pi)
                a_alt += 0.6 * math.sin(now * 0.4)

                # Derive instantaneous speed from previous tick to keep UI consistent with subscriber
                # (but still publish spd_mps directly for convenience)
                pos = {
                    "ts": now_iso(),
                    "lat": round(v_lat, 6),
                    "lon": round(v_lon, 6),
                    "alt_m": round(v_alt, 1),
                    "spd_mps": round(spd, 2),
                    "hdg_deg": round(v_heading, 1),
                    "vehicle_id": args.vehicle,
                    "src": "sim",
                }

                ac2_pos = {
                    "ts": now_iso(),
                    "lat": round(a_lat, 6),
                    "lon": round(a_lon, 6),
                    "alt_m": round(a_alt, 0),
                    "spd_mps": round(a_spd, 2),
                    "hdg_deg": round(a_heading, 1),
                    "callsign": "AC2",
                    "src": "sim",
                }

                base = f"{args.topic_base}/{args.vehicle}"
                client.publish(f"{base}/telemetry/pos", json.dumps(pos), qos=args.qos, retain=False)
                client.publish(f"{args.topic_base}/ac2/telemetry/pos", json.dumps(ac2_pos), qos=args.qos, retain=False)

                # --- Fused (optional) so UI can run without subscriber ---
                if args.emit_fused:
                    fused = {"vehicle": {"pos": pos}, "ac2": {"pos": ac2_pos}, "meta": {"rate_hz": args.rate}}
                    client.publish(f"{args.topic_base}/fused/{args.vehicle}",
                                   json.dumps(fused, separators=(",", ":")),
                                   qos=args.qos, retain=False)

                # schedule next
                next_pos += period_pos
                if now - next_pos > period_pos:
                    next_pos = now

            # --- WEATHER ---
            if now >= next_wx:
                base_temp = 22.0 + 2.0 * math.sin(now * 0.25)
                temp = base_temp + random.uniform(-0.3, 0.3)
                wind_spd = clamp(8 + 3 * math.sin(now * 0.35) + random.uniform(-0.7, 0.7), 0.0, 25.0)
                wind_dir = (180 + 25 * math.sin(now * 0.2) + random.uniform(-6, 6)) % 360
                rh = 45 + 8 * math.sin(now * 0.15) + random.uniform(-2, 2)
                pres = 1013.25 + 1.8 * math.sin(now * 0.1) + random.uniform(-0.4, 0.4)

                # keep small EMAs like your original for derived fields
                spd_hist_len = 10
                # not used here directly, but maintained for similarity with your prior structure
                # (you can drop if not needed)

                weather = {
                    "ts": now_iso(),
                    "temp_c": round(temp, 2),
                    "rh_pct": round(rh, 1),
                    "pres_hpa": round(pres, 2),
                    "wind_mps": round(wind_spd, 2),
                    "wind_dir_deg": round(wind_dir, 0),
                    "vehicle_id": args.vehicle,
                    "src": "sim",
                }
                client.publish(
                    f"{args.topic_base}/{args.vehicle}/telemetry/weather",
                    json.dumps(weather),
                    qos=args.qos,
                    retain=False,
                )

                next_wx += period_wx
                if now - next_wx > period_wx:
                    next_wx = now

            time.sleep(0.001)

    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
