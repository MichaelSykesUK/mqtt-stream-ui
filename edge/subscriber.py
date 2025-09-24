#!/usr/bin/env python3
import argparse, json, time, threading
from datetime import datetime, timezone
from collections import deque
import paho.mqtt.client as mqtt

TOPIC_BASE_DEFAULT = "airchase"

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--vehicle", default="pace_vehicle")
    ap.add_argument("--topic-base", default=TOPIC_BASE_DEFAULT)
    ap.add_argument("--emit-rate", type=float, default=10.0, help="fused publish rate in Hz")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    base = args.topic_base.rstrip("/")
    veh = args.vehicle

    # State we fuse
    state = {
        "veh_pos": {},          # last vehicle position payload
        "veh_weather": {},      # last vehicle weather payload
        "ac2_pos": {},          # last AC2 position payload
    }

    # MQTT client with v1 callbacks to avoid ReasonCode typing issues
    client = mqtt.Client(
        client_id=f"fuser-{veh}",
        protocol=mqtt.MQTTv311,
        transport="tcp",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION1,
    )

    # Subscribe on connect
    def on_connect(cli, userdata, flags, rc):
        print(f"[connected rc={rc}] subscribing…")
        topics = [
            (f"{base}/{veh}/telemetry/pos", 0),
            (f"{base}/{veh}/telemetry/weather", 0),
            (f"{base}/ac2/telemetry/pos", 0),
        ]
        for t, q in topics:
            cli.subscribe(t, qos=q)
            print(f"  - {t}")

    # Update state on messages
    def on_message(cli, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except Exception as e:
            if args.verbose:
                print(f"[warn] non-JSON on {msg.topic}: {e}")
            return

        t = msg.topic
        if t.endswith("/telemetry/pos") and t.startswith(f"{base}/{veh}/"):
            state["veh_pos"] = payload
        elif t.endswith("/telemetry/weather") and t.startswith(f"{base}/{veh}/"):
            state["veh_weather"] = payload
        elif t == f"{base}/ac2/telemetry/pos":
            state["ac2_pos"] = payload

        if args.verbose:
            print(f"[rx] {t}: {payload}")

    client.on_connect = on_connect
    client.on_message = on_message

    print(f"Connecting to {args.broker}:{args.port} and subscribing:")
    client.connect(args.broker, args.port, keepalive=30)
    client.loop_start()

    # Publisher thread at fixed rate
    stop = threading.Event()
    dt = 1.0 / max(0.1, args.emit_rate)

    def publisher():
        next_t = time.time()
        while not stop.is_set():
            next_t += dt
            fused = {
                "vehicle": {
                    "pos": state["veh_pos"] or {},
                    "weather": state["veh_weather"] or {},
                    # UI computes AVG/EMA; keep placeholders here if you want
                    "derived": {
                        "avg": {"spd_mps": None, "temp_c": None, "wind_mps": None},
                        "filtered": {"spd_mps": None, "temp_c": None, "wind_mps": None},
                    },
                },
                "ac2": {
                    "pos": state["ac2_pos"] or {}
                },
                "meta": {
                    "ts": now_iso(),
                    "rate_hz": float(args.emit_rate),
                },
            }
            topic_out = f"{base}/fused/{veh}"
            client.publish(topic_out, json.dumps(fused), qos=0, retain=False)
            if args.verbose:
                print(f"[tx] {topic_out}: {fused}")

            # sleep until next slot
            sl = next_t - time.time()
            if sl > 0:
                time.sleep(sl)
            else:
                # we're behind; catch up gently
                next_t = time.time()

    pub_thr = threading.Thread(target=publisher, name="fuser-pub", daemon=True)
    pub_thr.start()

    try:
        while True:
            time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        pub_thr.join(timeout=1.0)
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
