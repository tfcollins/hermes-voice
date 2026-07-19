const $ = (selector) => document.querySelector(selector);
const body = document.body;
const core = $('#core');
const activity = $('#activity');
const transcript = $('#transcript');
const commandInput = $('#commandInput');

let socket, audioContext, source, processor, stream, currentAudio, currentAudioResolve;
let listening = false;
let speaking = false;
let busy = false;
let voiceEnabled = localStorage.getItem('hermesVoiceEnabled') !== 'false';
let preRoll = [], utterance = [], inSpeech = false, silenceMs = 0, speechMs = 0;
let assistantArticle = null, assistantText = '', lastAssistantText = '';
let commandHistory = [];
try {
  commandHistory = JSON.parse(localStorage.getItem('hermesCommandHistory') || '[]');
  if (!Array.isArray(commandHistory)) commandHistory = [];
} catch {
  localStorage.removeItem('hermesCommandHistory');
}
let historyIndex = commandHistory.length;

const PRE_ROLL_MS = 360;
const SILENCE_END_MS = 850;
const MIN_UTTERANCE_MS = 430;
const SPEECH_THRESHOLD = 0.018;

const states = {
  connecting: ['INITIALIZING', 'Establishing link', 'Hermes is connecting to the local voice core.'],
  idle: ['VOICE CORE ONLINE', 'Standing by', 'Ask for information, action, or the next best step.'],
  listening: ['AUDIO CHANNEL OPEN', 'Listening', 'Speak naturally. I will respond after a short pause.'],
  transcribing: ['LOCAL SPEECH RECOGNITION', 'Transcribing', 'The GPU voice model is decoding your request.'],
  thinking: ['HERMES AGENT ACTIVE', 'Thinking', 'Hermes is reasoning about your request.'],
  working: ['TOOLS IN MOTION', 'Working', 'Hermes is taking action and verifying the result.'],
  speaking: ['VOICE RESPONSE', 'Speaking', 'Press Escape or start listening to interrupt.'],
  error: ['LINK EXCEPTION', 'Attention required', 'Check the activity display for details.']
};

function setState(state) {
  body.dataset.state = state;
  const [eyebrow, title, hint] = states[state] || states.idle;
  $('#eyebrow').textContent = eyebrow;
  $('#stateTitle').textContent = title;
  $('#stateHint').textContent = hint;
  $('#listenLabel').textContent = listening ? 'STOP LISTENING' : 'START LISTENING';
}

function setVoiceUI() {
  const button = $('#voiceButton');
  button.textContent = voiceEnabled ? 'VOICE ON' : 'VOICE OFF';
  button.setAttribute('aria-pressed', String(voiceEnabled));
  button.classList.toggle('off', !voiceEnabled);
}

function addActivity(label, cls = '') {
  if (activity.firstElementChild?.classList.contains('muted')) activity.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = label;
  li.className = cls;
  activity.prepend(li);
  while (activity.children.length > 12) activity.lastElementChild.remove();
  return li;
}

function addMessage(role, text = '') {
  const article = document.createElement('article');
  article.className = role;
  const who = document.createElement('span');
  who.textContent = role === 'user' ? 'YOU' : 'HERMES';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  article.append(who, paragraph);
  transcript.appendChild(article);
  transcript.scrollTop = transcript.scrollHeight;
  return article;
}

function rememberCommand(text) {
  if (commandHistory.at(-1) !== text) commandHistory.push(text);
  commandHistory = commandHistory.slice(-30);
  historyIndex = commandHistory.length;
  localStorage.setItem('hermesCommandHistory', JSON.stringify(commandHistory));
}

function sendPrompt(rawText) {
  const text = rawText.trim();
  if (!text) return;
  if (busy) {
    addActivity('Hermes is still working · wait for completion', 'failed');
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addActivity('Connection unavailable · prompt not sent', 'failed');
    return;
  }
  stopSpeaking(false);
  rememberCommand(text);
  socket.send(JSON.stringify({type: 'prompt', text}));
  busy = true;
  assistantArticle = null;
  assistantText = '';
  setState('thinking');
}

function resetVisibleConversation(sessionId, workspace) {
  transcript.innerHTML = '<article class="assistant welcome"><span>HERMES</span><p>New conversation ready. How can I help?</p></article>';
  activity.innerHTML = '';
  addActivity(`New session linked · ${workspace}`, 'done');
  $('#sessionLabel').textContent = sessionId.slice(-12).toUpperCase();
  assistantText = '';
  lastAssistantText = '';
  $('#repeatButton').disabled = true;
  busy = false;
  setState(listening ? 'listening' : 'idle');
}

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => {
    $('#connectionText').textContent = 'LINKED';
    $('#statusDot').style.background = 'var(--cyan)';
  };
  socket.onclose = () => {
    $('#connectionText').textContent = 'RECONNECTING';
    setState('connecting');
    setTimeout(connect, 1800);
  };
  socket.onerror = () => setState('error');
  socket.onmessage = async ({data}) => {
    const event = JSON.parse(data);
    const payload = event.payload || {};
    if (event.type === 'ready') {
      $('#sessionLabel').textContent = payload.session_id.slice(-12).toUpperCase();
      $('#listenButton').disabled = false;
      setState('idle');
      addActivity(`Session linked · ${payload.workspace}`, 'done');
    } else if (event.type === 'session.reset') {
      resetVisibleConversation(payload.session_id, payload.workspace);
    } else if (event.type === 'user.message') {
      addMessage('user', payload.content);
    } else if (event.type === 'run.started') {
      setState('thinking');
    } else if (event.type === 'assistant.delta') {
      if (!assistantArticle) assistantArticle = addMessage('assistant');
      assistantText += payload.delta || '';
      assistantArticle.querySelector('p').textContent = assistantText;
      transcript.scrollTop = transcript.scrollHeight;
    } else if (event.type === 'tool.started') {
      setState('working');
      addActivity(`${prettyTool(payload.tool_name)} · ${payload.preview || summarizeArgs(payload.args) || 'started'}`);
    } else if (event.type === 'tool.completed') {
      addActivity(`${prettyTool(payload.tool_name)} · complete`, 'done');
    } else if (event.type === 'tool.failed') {
      addActivity(`${prettyTool(payload.tool_name)} · failed`, 'failed');
    } else if (event.type === 'assistant.completed') {
      assistantText = payload.content || assistantText;
      if (!assistantArticle) assistantArticle = addMessage('assistant', assistantText);
      else assistantArticle.querySelector('p').textContent = assistantText;
    } else if (event.type === 'run.completed') {
      busy = false;
      lastAssistantText = assistantText;
      $('#repeatButton').disabled = !lastAssistantText;
      if (document.hidden && Notification.permission === 'granted') {
        new Notification('Hermes completed the request', {body: lastAssistantText.slice(0, 160)});
      }
      await speakReply(lastAssistantText);
    } else if (event.type === 'run.failed' || event.type === 'error') {
      busy = false;
      addActivity(payload.message || payload.error || 'Hermes turn failed', 'failed');
      setState('error');
    }
  };
}

function prettyTool(name = 'tool') {
  return name.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function summarizeArgs(args) {
  if (!args) return '';
  const value = typeof args === 'string' ? args : JSON.stringify(args);
  return value.length > 75 ? `${value.slice(0, 72)}…` : value;
}

async function ensureAudio() {
  if (audioContext) {
    if (audioContext.state === 'suspended') await audioContext.resume();
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    video: false
  });
  audioContext = new AudioContext();
  source = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(1536, 1, 1);
  source.connect(processor);
  processor.connect(audioContext.destination);
  processor.onaudioprocess = ({inputBuffer}) => processAudio(inputBuffer.getChannelData(0));
}

function processAudio(frame) {
  if (!listening || speaking || busy) return;
  const samples = new Float32Array(frame);
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  core.style.setProperty('--audio-level', Math.min(1, rms / .11));
  core.dataset.level = rms.toFixed(3);
  const duration = samples.length / audioContext.sampleRate * 1000;
  if (!inSpeech) {
    preRoll.push(samples);
    while (preRoll.reduce((count, item) => count + item.length, 0) > audioContext.sampleRate * PRE_ROLL_MS / 1000) preRoll.shift();
    if (rms > SPEECH_THRESHOLD) {
      inSpeech = true;
      utterance = [...preRoll, samples];
      preRoll = [];
      speechMs = duration;
      silenceMs = 0;
    }
  } else {
    utterance.push(samples);
    speechMs += duration;
    if (rms > SPEECH_THRESHOLD * .72) silenceMs = 0;
    else silenceMs += duration;
    if (silenceMs >= SILENCE_END_MS) finishUtterance();
  }
}

async function finishUtterance() {
  const frames = utterance;
  const duration = speechMs - silenceMs;
  utterance = [];
  inSpeech = false;
  silenceMs = 0;
  speechMs = 0;
  if (duration < MIN_UTTERANCE_MS) return;
  setState('transcribing');
  try {
    const wav = encodeWav(frames, audioContext.sampleRate);
    const form = new FormData();
    form.append('audio', wav, 'utterance.wav');
    const response = await fetch('/api/transcribe', {method: 'POST', body: form});
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (result.text) sendPrompt(result.text);
    else setState(listening ? 'listening' : 'idle');
  } catch (error) {
    addActivity(`Transcription · ${error.message}`, 'failed');
    setState('error');
  }
}

function encodeWav(frames, sampleRate) {
  const length = frames.reduce((count, item) => count + item.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) for (let sample of frame) {
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], {type: 'audio/wav'});
}

function stopSpeaking(announce = true) {
  if (!currentAudio) return false;
  currentAudio.pause();
  currentAudio.src = '';
  currentAudio = null;
  currentAudioResolve?.();
  currentAudioResolve = null;
  speaking = false;
  if (announce) addActivity('Voice response interrupted', 'done');
  setState(listening ? 'listening' : 'idle');
  return true;
}

async function toggleListening() {
  try {
    if (speaking) {
      stopSpeaking();
      await ensureAudio();
      listening = true;
    } else {
      await ensureAudio();
      listening = !listening;
    }
    setState(listening ? 'listening' : 'idle');
    addActivity(listening ? 'Microphone channel opened' : 'Microphone channel paused', listening ? '' : 'done');
  } catch (error) {
    addActivity(`Microphone · ${error.message}`, 'failed');
    setState('error');
  }
}

async function speakReply(text) {
  if (!text || !voiceEnabled || speaking) {
    setState(listening ? 'listening' : 'idle');
    return;
  }
  speaking = true;
  $('#repeatButton').textContent = 'STOP';
  setState('speaking');
  try {
    const response = await fetch('/api/speak', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text})
    });
    if (!response.ok) throw new Error(await response.text());
    const url = URL.createObjectURL(await response.blob());
    currentAudio = new Audio(url);
    await currentAudio.play();
    await new Promise((resolve) => {
      currentAudioResolve = resolve;
      currentAudio.onended = resolve;
      currentAudio.onerror = resolve;
    });
    URL.revokeObjectURL(url);
  } catch (error) {
    addActivity(`Voice · ${error.message}`, 'failed');
  } finally {
    currentAudio = null;
    currentAudioResolve = null;
    speaking = false;
    $('#repeatButton').textContent = 'REPEAT';
    setState(listening ? 'listening' : 'idle');
  }
}

core.onclick = toggleListening;
$('#listenButton').onclick = toggleListening;
$('#voiceButton').onclick = () => {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem('hermesVoiceEnabled', String(voiceEnabled));
  if (!voiceEnabled) stopSpeaking(false);
  setVoiceUI();
  addActivity(`Spoken responses ${voiceEnabled ? 'enabled' : 'muted'}`, 'done');
};
$('#repeatButton').onclick = () => speaking ? stopSpeaking() : speakReply(lastAssistantText);
$('#newButton').onclick = () => {
  if (busy) return addActivity('Wait for the current request before starting a new session', 'failed');
  if (!socket || socket.readyState !== WebSocket.OPEN) return addActivity('Connection unavailable · session not changed', 'failed');
  stopSpeaking(false);
  socket.send(JSON.stringify({type: 'new_session'}));
  setState('connecting');
};
$('#commandForm').onsubmit = (event) => {
  event.preventDefault();
  sendPrompt(commandInput.value);
  commandInput.value = '';
};
commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' && commandHistory.length) {
    event.preventDefault();
    historyIndex = Math.max(0, historyIndex - 1);
    commandInput.value = commandHistory[historyIndex];
  } else if (event.key === 'ArrowDown' && commandHistory.length) {
    event.preventDefault();
    historyIndex = Math.min(commandHistory.length, historyIndex + 1);
    commandInput.value = historyIndex === commandHistory.length ? '' : commandHistory[historyIndex];
  }
});
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.onclick = () => sendPrompt(button.dataset.prompt);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && speaking) {
    event.preventDefault();
    stopSpeaking();
  } else if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    toggleListening();
  }
});

setInterval(() => $('#clock').textContent = new Date().toLocaleTimeString('en-GB', {hour12: false}), 1000);
setVoiceUI();

// State-reactive background field: sparse geometry, not decorative fake metrics.
const canvas = $('#field');
const ctx = canvas.getContext('2d');
let particles = [];
function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  particles = Array.from({length: 52}, () => ({x: Math.random() * innerWidth, y: Math.random() * innerHeight, v: .08 + Math.random() * .18, r: .5 + Math.random() * 1.2}));
}
function draw(time) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const color = getComputedStyle(body).getPropertyValue('--state').trim() || '#63e8ff';
  ctx.strokeStyle = `${color}18`;
  ctx.lineWidth = .6;
  const centerX = innerWidth * .38, centerY = innerHeight * .42;
  for (let index = 0; index < 5; index++) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, 190 + index * 68, (time / 15000) * (index % 2 ? 1 : -1) + index, (time / 15000) * (index % 2 ? 1 : -1) + index + Math.PI * (.3 + index * .08));
    ctx.stroke();
  }
  ctx.fillStyle = color;
  for (const particle of particles) {
    particle.y -= particle.v;
    if (particle.y < 0) particle.y = innerHeight;
    ctx.globalAlpha = .12 + Math.sin(time / 1000 + particle.x) * .08;
    ctx.fillRect(particle.x, particle.y, particle.r, particle.r);
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(draw);
}
resize();
addEventListener('resize', resize);
requestAnimationFrame(draw);
connect();
