#!/usr/bin/env python3
"""Capture demo screens on an already booted iPhone; never creates or boots a device."""
import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parent
run = lambda args, **kwargs: subprocess.run(args, check=True, **kwargs)
devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "--json"]))
phones = [d for group in devices["devices"].values() for d in group if "iPhone" in d["name"] and d["state"] == "Booted"]
if len(sys.argv) > 1:
    phones = [d for d in phones if d["udid"] == sys.argv[1]]
if not phones:
    sys.exit("An existing iPhone must already be booted. No device was created or booted.")
device = phones[0]["udid"]
output = root.parent / "design/launch-kit/screens-ios"
output.mkdir(parents=True, exist_ok=True)
for number, name, screen in [
    (1, "bots-home", "home"), (2, "bot-thread", "thread"),
    (3, "tasks", "tasks"), (4, "usage", "usage"), (5, "connect", "connect"),
    (6, "question", "question"), (7, "new-bot", "newBot"),
    (8, "bot-settings", "settings"), (9, "you", "you"),
]:
    run(["xcrun", "simctl", "launch", "--terminate-running-process", device,
         "app.swarmaa.ios", "-demo", "-screen", screen], stdout=subprocess.DEVNULL)
    time.sleep(3)  # Allow the actual launch and sheet animations to finish.
    run(["xcrun", "simctl", "io", device, "screenshot", str(output / f"{number:02}-{name}.png")], stdout=subprocess.DEVNULL)
print(f"Captured 9 screens from {phones[0]['name']} ({device}).")
