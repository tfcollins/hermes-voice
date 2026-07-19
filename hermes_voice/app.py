from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import edge_tts
import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

log = logging.getLogger("hermes_voice")
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

HERMES_URL = os.getenv("HERMES_API_URL", "http://127.0.0.1:8642").rstrip("/")
HERMES_KEY = os.getenv("HERMES_API_KEY", "")
HAL_URL = os.getenv("HAL_API_URL", "http://10.0.0.113:8091").rstrip("/")
HAL_KEY = os.getenv("HAL_API_KEY", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "distil-large-v3")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
VOICE = os.getenv("HERMES_VOICE", "en-GB-RyanNeural")
WORKSPACE = os.getenv("HERMES_WORKSPACE", str(Path.home() / "dev"))

_whisper: Any | None = None
_whisper_lock = asyncio.Lock()


def spoken_text(text: str, limit: int = 3500) -> str:
    """Turn a visual Markdown response into natural text for speech synthesis."""
    text = re.sub(r"```[^\n]*\n(.*?)```", r" Code omitted. ", text, flags=re.DOTALL)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[([^]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+[.)]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_~>|]", "", text)
    text = re.sub(r"https?://\S+", "link", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit].strip()


def auth_headers() -> dict[str, str]:
    if not HERMES_KEY:
        raise RuntimeError("HERMES_API_KEY is not configured")
    return {"Authorization": f"Bearer {HERMES_KEY}", "Content-Type": "application/json"}


def hal_headers() -> dict[str, str]:
    if not HAL_KEY:
        raise RuntimeError("HAL_API_KEY is not configured")
    return {"Authorization": f"Bearer {HAL_KEY}", "Content-Type": "application/json"}


async def hermes_health() -> dict[str, Any]:
    if not HERMES_KEY:
        return {"ok": False, "detail": "Hermes API key is not configured"}
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(f"{HERMES_URL}/v1/health", headers=auth_headers())
            return {"ok": response.is_success, "status": response.status_code}
    except Exception as exc:
        return {"ok": False, "detail": type(exc).__name__}


async def hal_models() -> list[dict[str, str]]:
    """Return HAL's allow-listed direct-run models, or an empty list if offline."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{HAL_URL}/api/assistant/models")
            response.raise_for_status()
            return list(response.json().get("models", []))
    except Exception:
        log.warning("HAL model catalog is unavailable", exc_info=True)
        return []


def hal_event_to_voice(event: dict[str, Any]) -> dict[str, Any] | None:
    """Translate a normalized HAL event into the Voice Core event vocabulary."""
    kind = event.get("kind")
    if kind == "text" and event.get("text"):
        return {"type": "assistant.delta", "payload": {"delta": event["text"]}}
    if kind == "tool_use":
        return {
            "type": "tool.started",
            "payload": {
                "tool_name": event.get("tool_name") or "HAL tool",
                "args": event.get("tool_input") or {},
                "preview": f"HAL · {event.get('adapter') or 'agent'}",
            },
        }
    if kind == "tool_result":
        return {
            "type": "tool.completed",
            "payload": {"tool_name": event.get("tool_name") or "HAL tool"},
        }
    if kind == "task_started":
        return {
            "type": "tool.started",
            "payload": {
                "tool_name": "HAL subagent",
                "preview": event.get("task_description") or "delegated task",
            },
        }
    if kind == "task_completed":
        return {"type": "tool.completed", "payload": {"tool_name": "HAL subagent"}}
    if kind == "rate_limit":
        return {
            "type": "tool.started",
            "payload": {
                "tool_name": "HAL rate limit",
                "preview": event.get("rate_limit_status") or "waiting",
            },
        }
    if kind == "error":
        return {
            "type": "run.failed",
            "payload": {"message": event.get("error_message") or "HAL model failed"},
        }
    return None


async def stream_hal_turn(model: str, text: str) -> AsyncIterator[dict[str, Any]]:
    """Submit a HAL model run and poll its normalized event/result stream."""
    timeout = httpx.Timeout(connect=10, read=30, write=30, pool=10)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{HAL_URL}/api/assistant/runs",
            headers=hal_headers(),
            json={"prompt": text, "model": model, "timeout_seconds": 600},
        )
        if not response.is_success:
            raise RuntimeError(f"HAL returned {response.status_code}: {response.text[:500]}")
        run_id = str(response.json()["id"])
        yield {"type": "run.started", "payload": {"model": model, "run_id": run_id}}
        seen = 0
        for _ in range(1_200):
            status_response = await client.get(
                f"{HAL_URL}/api/assistant/runs/{run_id}", headers=hal_headers()
            )
            if not status_response.is_success:
                raise RuntimeError(
                    f"HAL status returned {status_response.status_code}: "
                    f"{status_response.text[:500]}"
                )
            run = status_response.json()
            events = run.get("events") or []
            for event in events[seen:]:
                translated = hal_event_to_voice(event)
                if translated:
                    yield translated
            seen = len(events)
            if run.get("status") == "completed":
                output = str((run.get("result") or {}).get("output") or "").strip()
                yield {"type": "assistant.completed", "payload": {"content": output}}
                yield {
                    "type": "run.completed",
                    "payload": {"model": model, "run_id": run_id},
                }
                return
            if run.get("status") in {"failed", "cancelled"}:
                result = run.get("result") or {}
                detail = result.get("error") or result.get("output") or "HAL run failed"
                yield {
                    "type": "run.failed",
                    "payload": {"model": model, "run_id": run_id, "error": str(detail)},
                }
                return
            await asyncio.sleep(0.5)
    raise RuntimeError("HAL run exceeded the Voice Core polling deadline")


async def get_whisper() -> Any:
    global _whisper
    if _whisper is not None:
        return _whisper
    async with _whisper_lock:
        if _whisper is None:
            from faster_whisper import WhisperModel

            log.info("Loading Whisper model=%s device=%s", WHISPER_MODEL, WHISPER_DEVICE)
            try:
                _whisper = await asyncio.to_thread(
                    WhisperModel,
                    WHISPER_MODEL,
                    device=WHISPER_DEVICE,
                    compute_type=WHISPER_COMPUTE,
                )
            except Exception:
                if WHISPER_DEVICE == "cpu":
                    raise
                log.exception("GPU Whisper failed; falling back to CPU int8")
                _whisper = await asyncio.to_thread(
                    WhisperModel, WHISPER_MODEL, device="cpu", compute_type="int8"
                )
    return _whisper


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    yield


app = FastAPI(title="Hermes Voice Core", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health() -> JSONResponse:
    h, available_hal_models = await asyncio.gather(hermes_health(), hal_models())
    return JSONResponse(
        {
            "status": "ok" if h["ok"] else "degraded",
            "hermes": h,
            "hal": {
                "ok": bool(available_hal_models),
                "url": HAL_URL,
                "models": len(available_hal_models),
            },
            "voice": VOICE,
            "whisper": {"model": WHISPER_MODEL, "device": WHISPER_DEVICE},
        }
    )


@app.get("/api/models")
async def models() -> dict[str, list[dict[str, str]]]:
    return {
        "models": [
            {
                "id": "hermes",
                "label": "Hermes Agent",
                "provider": "hermes",
                "description": "Default tool-using Hermes session with memory and skills.",
            },
            *(await hal_models()),
        ]
    }


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict[str, Any]:
    suffix = Path(audio.filename or "utterance.wav").suffix or ".wav"
    data = await audio.read()
    if len(data) < 1_000:
        raise HTTPException(400, "Audio sample is too short")
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            path = Path(tmp.name)
        model = await get_whisper()

        def run() -> tuple[str, float]:
            segments, info = model.transcribe(
                str(path),
                language="en",
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 350},
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            probability = float(getattr(info, "language_probability", 0.0) or 0.0)
            return text, probability

        text, probability = await asyncio.to_thread(run)
        return {"text": text, "confidence": probability}
    finally:
        if path:
            path.unlink(missing_ok=True)


@app.post("/api/speak")
async def speak(payload: dict[str, Any]) -> FileResponse:
    text = spoken_text(str(payload.get("text") or ""))
    if not text:
        raise HTTPException(400, "Text is required")

    out = Path(tempfile.gettempdir()) / f"hermes-voice-{uuid.uuid4().hex}.mp3"
    try:
        await edge_tts.Communicate(text, VOICE, rate="-4%", pitch="-2Hz").save(str(out))
    except Exception as exc:
        log.exception("TTS failed")
        raise HTTPException(502, f"Voice synthesis failed: {type(exc).__name__}") from exc
    return FileResponse(
        out,
        media_type="audio/mpeg",
        filename="hermes-response.mp3",
        background=BackgroundTask(out.unlink, missing_ok=True),
    )


async def create_session() -> str:
    body = {
        "title": f"Voice Core {uuid.uuid4().hex[:6].upper()}",
        "system_prompt": (
            "You are a proactive, dependable workstation assistant speaking through a voice-first "
            "interface. Use tools when they improve accuracy and complete requested actions rather "
            "than only explaining them. Keep spoken replies clear and concise unless detail is "
            "requested. Lead with the result, state blockers honestly, and offer one useful next "
            "step when appropriate. Ask a focused clarification only when ambiguity materially "
            "changes the action. Avoid markdown tables in brief spoken answers. You are Hermes "
            "Agent; do not claim to be JARVIS or a Marvel character. "
            "The voice console is physically on Picard.local. For workstation-specific commands "
            "and file operations, use SSH to picard.local unless the user names another host."
        ),
    }
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{HERMES_URL}/api/sessions", headers=auth_headers(), json=body
        )
        if not response.is_success:
            raise RuntimeError(
                f"Hermes session creation returned {response.status_code}: {response.text[:500]}"
            )
        return str(response.json()["session"]["id"])


async def parse_sse(response: httpx.Response) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    event_name = "message"
    data_lines: list[str] = []
    async for line in response.aiter_lines():
        if line == "":
            if data_lines:
                raw = "\n".join(data_lines)
                try:
                    yield event_name, json.loads(raw)
                except json.JSONDecodeError:
                    yield event_name, {"raw": raw}
            event_name, data_lines = "message", []
        elif line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        raw = "\n".join(data_lines)
        try:
            yield event_name, json.loads(raw)
        except json.JSONDecodeError:
            yield event_name, {"raw": raw}


async def stream_turn(session_id: str, text: str) -> AsyncIterator[dict[str, Any]]:
    body = {"input": text}
    timeout = httpx.Timeout(connect=10, read=None, write=30, pool=10)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            f"{HERMES_URL}/api/sessions/{session_id}/chat/stream",
            headers=auth_headers(),
            json=body,
        ) as response:
            if not response.is_success:
                detail = (await response.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"Hermes returned {response.status_code}: {detail}")
            async for event, payload in parse_sse(response):
                yield {"type": event, "payload": payload}


@app.websocket("/ws")
async def voice_socket(ws: WebSocket) -> None:
    await ws.accept()
    session_id: str | None = None
    try:
        await ws.send_json({"type": "state", "payload": {"state": "connecting"}})
        session_id = await create_session()
        await ws.send_json(
            {
                "type": "ready",
                "payload": {"session_id": session_id, "workspace": WORKSPACE},
            }
        )
        while True:
            message = await ws.receive_json()
            if message.get("type") == "ping":
                await ws.send_json({"type": "pong", "payload": {}})
                continue
            if message.get("type") == "new_session":
                session_id = await create_session()
                await ws.send_json(
                    {
                        "type": "session.reset",
                        "payload": {"session_id": session_id, "workspace": WORKSPACE},
                    }
                )
                continue
            if message.get("type") != "prompt":
                continue
            text = str(message.get("text") or "").strip()
            if not text:
                continue
            await ws.send_json({"type": "user.message", "payload": {"content": text}})
            try:
                model = str(message.get("model") or "hermes")
                event_stream = (
                    stream_turn(session_id, text)
                    if model == "hermes"
                    else stream_hal_turn(model, text)
                )
                async for event in event_stream:
                    await ws.send_json(event)
                    effective = event.get("payload", {}).get("session_id")
                    if effective:
                        session_id = str(effective)
            except WebSocketDisconnect:
                return
            except Exception as exc:
                log.exception("Voice model turn failed")
                try:
                    await ws.send_json(
                        {"type": "error", "payload": {"message": f"Model error: {exc}"}}
                    )
                except WebSocketDisconnect:
                    return
    except WebSocketDisconnect:
        return
    except Exception as exc:
        log.exception("Voice socket failed")
        try:
            await ws.send_json({"type": "error", "payload": {"message": str(exc)}})
        except Exception:
            pass
