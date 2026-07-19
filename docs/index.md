<div class="hero" markdown>
<span class="hero__eyebrow">VOICE CORE // LINUX WORKSTATION</span>

# Talk to Hermes. Watch it work.

A cinematic, voice-first interface for Hermes Agent with local GPU transcription, live tool activity, and spoken responses.

<div class="hero__actions" markdown>
[Start using it](getting-started.md){ .md-button .md-button--primary }
[Explore the interface](interface.md){ .md-button }
</div>
</div>

<div class="signal-strip">
  <div><strong>Local STT</strong><span>faster-whisper on CUDA</span></div>
  <div><strong>Live tools</strong><span>Hermes session events</span></div>
  <div><strong>Voice out</strong><span>British neural speech</span></div>
  <div><strong>Private bind</strong><span>Loopback-only UI</span></div>
</div>

<div class="screenshot-frame" markdown>
[![Hermes Voice Core standing by on Picard](assets/screenshots/voice-core-overview.png)](assets/screenshots/voice-core-overview.png)
</div>
<p class="screenshot-caption">The ready state on Picard: the central core is idle, Hermes is linked, and the voice channel is ready.</p>

## One interaction, five visible states

The core is not a decorative animation. It communicates where a request is in the pipeline:

<div class="grid cards" markdown>

-   **Listening**

    The microphone channel is open. Voice activity detection keeps a short pre-roll and waits for a natural pause.

-   **Transcribing**

    Audio is decoded locally by `faster-whisper`; the default model is `distil-large-v3` on CUDA.

-   **Thinking & working**

    Hermes streams reasoning progress and tool lifecycle events into the activity rail.

-   **Speaking**

    The completed response is synthesized and played while the core changes to its voice-response state.

</div>

## Built to assist, not merely answer

The console includes the interaction details that make a voice agent useful throughout the day:

- **Action-first behavior** — Hermes uses tools when they improve accuracy, leads with the result, and reports blockers honestly.
- **Interruptible speech** — press ++esc++ or start listening to stop a response immediately.
- **Conversation control** — create a genuinely new Hermes session instead of only clearing visible text.
- **Useful starting points** — check Picard, resume recent work, or review capabilities with one selection.
- **Persistent preferences** — spoken responses and typed-command history survive a page reload.
- **Natural speech rendering** — headings, links, lists, code fences, and other visual Markdown are cleaned before synthesis.

## What stays local

Microphone audio is captured by the browser and sent only to the local FastAPI service. Speech-to-text runs on the workstation. Hermes receives the resulting text through its authenticated Sessions API; generated speech is returned to the browser as temporary audio.

!!! note "Original voice and visual identity"
    The interface uses an original Hermes visual system and a generic British neural voice. It does not clone an actor's voice or reuse Marvel assets.

## Next

- Follow [Get started](getting-started.md) to launch the interface and grant microphone access.
- Read [Use the interface](interface.md) for controls and state meanings.
- See [Architecture](architecture.md) for the complete audio-to-agent path.
