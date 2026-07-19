import json

import pytest

from hermes_voice.app import auth_headers, parse_sse


def test_auth_headers_requires_key(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HERMES_KEY", "")
    with pytest.raises(RuntimeError):
        auth_headers()


def test_auth_headers(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HERMES_KEY", "test-key")
    assert auth_headers()["Authorization"] == "Bearer test-key"


@pytest.mark.asyncio
async def test_parse_sse():
    class Response:
        async def aiter_lines(self):
            for line in [
                "event: assistant.delta",
                'data: {"delta":"Good"}',
                "",
                "event: tool.started",
                'data: {"tool_name":"terminal"}',
                "",
            ]:
                yield line

    events = [event async for event in parse_sse(Response())]
    assert events == [
        ("assistant.delta", {"delta": "Good"}),
        ("tool.started", {"tool_name": "terminal"}),
    ]
