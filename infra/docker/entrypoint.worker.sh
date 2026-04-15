#!/usr/bin/env bash
set -euo pipefail

if pulseaudio --check 2>/dev/null; then
  echo "PulseAudio already running"
else
  pulseaudio --daemonize=yes --exit-idle-time=-1
fi

for attempt in $(seq 1 20); do
  if pactl info >/dev/null 2>&1; then
    break
  fi

  sleep 0.25
done

if ! pactl info >/dev/null 2>&1; then
  echo "PulseAudio did not become ready" >&2
  exit 1
fi

if [[ -n "${WORKER_VIDEO_DEVICES:-}" ]]; then
  missing_devices=()
  IFS=',' read -ra video_devices <<< "${WORKER_VIDEO_DEVICES}"
  for device in "${video_devices[@]}"; do
    trimmed="$(echo "$device" | xargs)"
    if [[ -n "$trimmed" && ! -e "$trimmed" ]]; then
      missing_devices+=("$trimmed")
    fi
  done

  if [[ "${#missing_devices[@]}" -gt 0 ]]; then
    echo "Configured video devices are missing: ${missing_devices[*]}" >&2
    echo "Load v4l2loopback on the Linux host and map the devices into the container before starting the worker." >&2
    exit 1
  fi
fi

exec node apps/worker/dist/main.js
