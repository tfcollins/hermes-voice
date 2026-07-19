# Configuration

The service reads configuration from environment variables at process startup. Restart it after changing values.

## Environment reference

| Variable | Default | Description |
|---|---|---|
| `HERMES_API_URL` | `http://127.0.0.1:8642` | Base URL of the authenticated Hermes API server. |
| `HERMES_API_KEY` | — | Required bearer token for Hermes requests. |
| `HERMES_WORKSPACE` | `~/dev` | Workspace label sent to the HUD when a session is ready. |
| `WHISPER_MODEL` | `distil-large-v3` | faster-whisper model name or local model path. |
| `WHISPER_DEVICE` | `cuda` | CTranslate2 execution device; use `cpu` when no supported GPU is available. |
| `WHISPER_COMPUTE_TYPE` | `float16` | Compute type, commonly `float16` on CUDA or `int8` on CPU. |
| `HERMES_VOICE` | `en-GB-RyanNeural` | Edge TTS voice identifier. |
| `LOG_LEVEL` | `INFO` | Python logging level. |

## Recommended profiles

=== "NVIDIA GPU"

    ```dotenv
    WHISPER_MODEL=distil-large-v3
    WHISPER_DEVICE=cuda
    WHISPER_COMPUTE_TYPE=float16
    ```

    This provides the best default accuracy/latency balance on an 8 GiB workstation GPU.

=== "CPU-only"

    ```dotenv
    WHISPER_MODEL=small.en
    WHISPER_DEVICE=cpu
    WHISPER_COMPUTE_TYPE=int8
    ```

    This uses less memory and avoids CUDA dependencies at the cost of accuracy and latency.

=== "Lower GPU memory"

    ```dotenv
    WHISPER_MODEL=small.en
    WHISPER_DEVICE=cuda
    WHISPER_COMPUTE_TYPE=float16
    ```

## CUDA runtime libraries

CTranslate2 must be able to locate compatible CUDA and cuDNN libraries. When they are installed outside the system linker path, add them to the systemd environment file:

```dotenv
LD_LIBRARY_PATH=/path/to/cuda/lib64:/path/to/cudnn/lib
```

Then restart the bridge:

```bash
systemctl --user restart hermes-voice.service
```

Validate CUDA visibility inside the project environment:

```bash
uv run python - <<'PY'
import ctranslate2
print("CUDA devices:", ctranslate2.get_cuda_device_count())
print("Compute types:", ctranslate2.get_supported_compute_types("cuda"))
PY
```

## Voice selection

List available English voices:

```bash
uv run edge-tts --list-voices | grep '^Name: en-'
```

Set the chosen identifier in the environment file and restart the service. Keep the selected voice an original stock or appropriately licensed synthetic voice; do not configure an unauthorized actor voice clone.

## Browser listening thresholds

Voice activity constants currently live in `hermes_voice/static/app.js`:

| Constant | Default | Effect |
|---|---:|---|
| `PRE_ROLL_MS` | 360 ms | Audio retained before speech onset. |
| `SILENCE_END_MS` | 850 ms | Silence required to close an utterance. |
| `MIN_UTTERANCE_MS` | 430 ms | Shorter detections are discarded. |
| `SPEECH_THRESHOLD` | 0.018 RMS | Energy required to begin an utterance. |

Raise `SPEECH_THRESHOLD` in a noisy room. Increase `SILENCE_END_MS` if natural pauses split one request into multiple utterances.

## Service hardening

The supplied service uses a user unit and loopback bind. For a stricter deployment, consider these systemd options after verifying required file access:

```ini
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.cache
```

Hermes itself remains a privileged agent runtime by design; apply its own approval and tool policies separately.
