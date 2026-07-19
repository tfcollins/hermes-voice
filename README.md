# Hermes Voice Core

A voice-first cinematic HUD for Hermes Agent on Linux. It uses browser audio capture with voice activity detection, local `faster-whisper` transcription, Hermes' authenticated Sessions streaming API, HAL-hosted Claude and Antigravity models, and an original British neural TTS voice.

![Hermes Voice Core standing by](docs/assets/screenshots/voice-core-overview.png)

## Documentation

Build and preview the MkDocs Material site:

```bash
uv sync --extra docs
uv run mkdocs build --strict
uv run mkdocs serve
```

Then open <http://127.0.0.1:8000>.

Published documentation: <https://tfcollins.github.io/hermes-voice/>

## Run

```bash
uv sync --extra test
HERMES_API_KEY=... HAL_API_KEY=... uv run uvicorn hermes_voice.app:app --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765`, allow microphone access once, then click the core or press Space. The listener uses a short pre-roll and stops an utterance after sustained silence.

Assistant controls include interruptible speech, persistent voice on/off, repeat, a real new-session action, typed-command history, and suggested workflows for Picard health and recent work. Visual Markdown is cleaned before TTS while the full response remains visible.

## Environment

- `HERMES_API_URL` (default `http://127.0.0.1:8642`)
- `HERMES_API_KEY` (required)
- `HAL_API_URL` (default `http://10.0.0.113:8091`)
- `HAL_API_KEY` (required to run HAL models; never sent to the browser)
- `WHISPER_MODEL` (default `distil-large-v3`)
- `WHISPER_DEVICE` (default `cuda`)
- `WHISPER_COMPUTE_TYPE` (default `float16`)
- `HERMES_VOICE` (default `en-GB-RyanNeural`)
- `HERMES_WORKSPACE` (default `~/dev`)

This project intentionally does not clone Paul Bettany's voice or use Marvel visual assets.
