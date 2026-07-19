# Operations

## Service commands

```bash
# Current state
systemctl --user status hermes-voice.service

# Restart after configuration or code changes
systemctl --user restart hermes-voice.service

# Follow logs
journalctl --user -u hermes-voice.service -f

# Disable automatic startup
systemctl --user disable --now hermes-voice.service
```

## Health checks

### Voice bridge and Hermes

```bash
curl --fail --silent http://127.0.0.1:8765/api/health | python -m json.tool
```

Expected shape:

```json
{
  "status": "ok",
  "hermes": {"ok": true, "status": 200},
  "voice": "en-GB-RyanNeural",
  "whisper": {"model": "distil-large-v3", "device": "cuda"}
}
```

### Microphone

```bash
arecord -D default -f S16_LE -r 16000 -c 1 -d 2 /tmp/hermes-mic.wav
ffprobe -v error \
  -show_entries format=duration,size \
  -show_entries stream=sample_rate,channels \
  -of default=noprint_wrappers=1 \
  /tmp/hermes-mic.wav
```

### GPU

After at least one transcription:

```bash
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

## Troubleshooting

### The page stays on “Establishing link”

1. Check the bridge service.
2. Query `/api/health`.
3. Confirm `HERMES_API_URL` is reachable from the bridge host.
4. Confirm `HERMES_API_KEY` matches the API server key.
5. Look for session creation errors in the journal.

```bash
journalctl --user -u hermes-voice.service -n 100 --no-pager
```

### Microphone permission is denied

Open Chrome's site controls for `http://127.0.0.1:8765`, set **Microphone** to **Allow**, and reload the app. Also confirm PipeWire exposes a default source:

```bash
wpctl status
```

### No speech is detected

- Confirm the correct input is selected in the desktop audio settings.
- Test with `arecord`.
- Lower `SPEECH_THRESHOLD` slightly in `app.js` for a quiet microphone.
- Check whether browser noise suppression is removing a very low signal.

### `libcublas.so.12` or cuDNN cannot be loaded

The GPU is visible, but its runtime libraries are not in the service link path. Locate the required libraries and add their directories to `LD_LIBRARY_PATH` in `~/.config/hermes-voice/environment`, then restart the service.

```bash
systemctl --user restart hermes-voice.service
journalctl --user -u hermes-voice.service -n 80 --no-pager
```

### TTS fails but text appears

The agent turn succeeded; only speech synthesis failed. Check network access to the configured TTS provider and inspect the `POST /api/speak` error. The written response remains usable in the conversation panel.

### Tool activity does not appear

The selected Hermes endpoint must support the Sessions streaming API and emit tool lifecycle events. Check that the bridge is calling `/api/sessions/{id}/chat/stream`, not a non-streaming completion endpoint.

## Update the application

From the project checkout:

```bash
uv sync --extra test --extra docs
uv run pytest
systemctl --user restart hermes-voice.service
curl --fail http://127.0.0.1:8765/api/health
```

## Build these docs

```bash
uv sync --extra docs
uv run mkdocs build --strict
uv run mkdocs serve
```

The site is written to `site/`. The development server defaults to `http://127.0.0.1:8000`.

## Collect a support bundle

This command records status without printing the secret environment file:

```bash
{
  date
  systemctl --user status hermes-voice.service --no-pager
  curl --silent http://127.0.0.1:8765/api/health
  wpctl status
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
  journalctl --user -u hermes-voice.service -n 200 --no-pager
} > /tmp/hermes-voice-support.txt 2>&1
```

Review the bundle before sharing it.
