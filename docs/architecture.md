# Architecture

Hermes Voice Core is a thin local interaction layer. It owns microphone capture, speech recognition, model selection, state visualization, and speech playback. Hermes remains the default agent runtime; HAL provides isolated direct runs through Claude and Antigravity adapters.

## Request path

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser HUD
    participant V as Voice bridge
    participant W as faster-whisper
    participant H as Hermes API
    participant HAL as HAL model fabric
    participant T as Agent tools
    participant S as Neural TTS

    U->>B: Speak request
    B->>B: Voice activity detection
    B->>V: POST /api/transcribe (WAV)
    V->>W: Decode locally
    W-->>V: Transcript
    V-->>B: Text + confidence
    B->>V: WebSocket prompt + selected model
    alt Hermes selected
        V->>H: Session chat stream
        H->>T: Execute tools
        T-->>H: Tool results
        H-->>V: SSE deltas + tool events
    else HAL model selected
        V->>HAL: Bearer-authenticated direct run
        HAL->>T: Claude or Antigravity tools
        T-->>HAL: Tool results
        HAL-->>V: Normalized run events
    end
    V-->>B: WebSocket state updates
    B->>V: POST /api/speak
    V->>S: Synthesize response
    S-->>V: MP3
    V-->>B: Temporary audio
    B-->>U: Spoken response
```

## Components

### Browser HUD

The static HTML, CSS, and JavaScript under `hermes_voice/static/` provide:

- WebSocket connection and session state
- microphone access through `getUserMedia`
- in-browser energy-based voice activity detection
- WAV encoding without an additional browser library
- streamed transcript and tool-progress rendering
- audio playback and state-reactive animation

The browser never receives the Hermes API key.

### Voice bridge

`hermes_voice.app` is a FastAPI service bound to loopback by the supplied systemd unit. It exposes:

| Endpoint | Purpose |
|---|---|
| `GET /` | Serve the HUD. |
| `GET /api/health` | Report bridge, Hermes, voice, and Whisper status. |
| `GET /api/models` | Combine Hermes with HAL's live allow-listed model catalog. |
| `POST /api/transcribe` | Accept an audio upload and return local transcription. |
| `POST /api/speak` | Synthesize a bounded spoken response. |
| `WS /ws` | Create a Hermes session and relay streamed events. |

Temporary transcription and TTS files are removed after use.

### Speech recognition

The default `distil-large-v3` model is loaded lazily and retained in process memory. GPU initialization uses the configured CUDA compute type. If GPU model construction fails, the service falls back to CPU `int8`; runtime CUDA library failures after construction still surface as transcription errors and should be corrected in the service library path.

### Hermes session stream

Each browser connection creates a uniquely titled Hermes API session. Prompts use:

```text
POST /api/sessions/{session_id}/chat/stream
```

The bridge parses server-sent events and forwards their names and payloads over the browser WebSocket. Important events are:

- `assistant.delta`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `assistant.completed`
- `run.completed`
- `run.failed`

### HAL direct runs

For a HAL selection, the bridge submits an authenticated `POST /api/assistant/runs`, then polls the protected run resource. HAL routes the stable model ID through its Claude or Antigravity adapter and emits normalized text, tool, task, rate-limit, and error events. The bridge translates those events into the same HUD vocabulary used by Hermes.

HAL runs execute in isolated `/data/workspaces/assistant/<run-id>` directories and do not expose Claude, Google, or HAL credentials to Picard's browser.

### Speech synthesis

Completed assistant text is converted from visual Markdown to natural speech and limited to 3,500 characters before synthesis. Headings, list markers, formatting punctuation, raw URLs, and fenced code are cleaned without changing the written transcript. The default voice is `en-GB-RyanNeural` with a slightly slower rate and lower pitch. The generated MP3 is deleted by a response background task after delivery.

Playback is interruptible in the browser. Voice on/off and typed-command history are browser-local preferences; starting a new conversation requests a new session from the bridge.

## Trust boundaries

```mermaid
flowchart LR
    subgraph Workstation[Linux workstation]
        UI[Browser HUD]
        Bridge[Voice bridge :8765]
        STT[Local Whisper / CUDA]
        Audio[PipeWire audio]
        UI <--> Audio
        UI <--> Bridge
        Bridge <--> STT
    end

    subgraph AgentHost[Hermes host or local process]
        API[Authenticated Hermes API :8642]
        Agent[Hermes Agent]
        Tools[Terminal · files · web · skills]
        API --> Agent --> Tools
    end

    subgraph HALHost[HAL on Vulkan]
        HALAPI[Bearer-protected assistant API]
        Claude[Claude adapter]
        AGY[Antigravity adapter]
        HALAPI --> Claude
        HALAPI --> AGY
    end

    Bridge -->|Hermes bearer key| API
    Bridge -->|Dedicated HAL bearer key| HALAPI
```

!!! danger "Agent credentials cross high-trust boundaries"
    Anyone who can read the bridge environment file can invoke the configured Hermes API and HAL direct-run API. Protect the file, bind the bridge to loopback, and do not expose it as a public unauthenticated web application. HAL rejects missing or invalid run credentials; the browser receives only model metadata, never either bearer key.

## Failure behavior

- Browser disconnects stop event forwarding without crashing the service.
- Hermes HTTP errors are converted into an `error` WebSocket event.
- Empty or extremely short audio uploads are rejected.
- Failed GPU initialization attempts CPU transcription.
- TTS provider failures return HTTP 502 and leave the written response visible in the transcript.
