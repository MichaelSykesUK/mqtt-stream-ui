import json, time, yaml
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
from reader import read_sample  # implement to parse your device

cfg = yaml.safe_load(open("config.yaml"))
cli = mqtt.Client(client_id=f"edge-{cfg['vehicle_id']}")
cli.username_pw_set(cfg["mqtt"]["user"], cfg["mqtt"]["pass"])
cli.will_set(f"airchase/{cfg['vehicle_id']}/telemetry/status",
             json.dumps({"ts": datetime.now(timezone.utc).isoformat(),"status":"offline"}),
             retain=True)
cli.connect(cfg["mqtt"]["host"], cfg["mqtt"]["port"], 60)
cli.loop_start()

while True:
    d = read_sample(cfg)               # {lat,lon,...}
    d["ts"] = datetime.now(timezone.utc).isoformat()
    base = f"airchase/{cfg['vehicle_id']}/telemetry"
    cli.publish(f"{base}/weather", json.dumps(d), qos=1)
    time.sleep(cfg["rate_sec"])
