const $ = (s) => document.querySelector(s);
const body = document.body;
const core = $('#core');
const activity = $('#activity');
const transcript = $('#transcript');
let socket, audioContext, source, processor, stream;
let listening = false, speaking = false, busy = false;
let preRoll = [], utterance = [], inSpeech = false, silenceMs = 0, speechMs = 0;
let assistantArticle = null, assistantText = '';
const SAMPLE_WINDOW_MS = 32;
const PRE_ROLL_MS = 360;
const SILENCE_END_MS = 850;
const MIN_UTTERANCE_MS = 430;
const SPEECH_THRESHOLD = 0.018;

const states = {
  connecting: ['INITIALIZING', 'Establishing link', 'Hermes is connecting to the local voice core.'],
  idle: ['VOICE CORE ONLINE', 'Standing by', 'Press Space or select the core to begin listening.'],
  listening: ['AUDIO CHANNEL OPEN', 'Listening', 'Speak naturally. I will respond after a short pause.'],
  transcribing: ['LOCAL SPEECH RECOGNITION', 'Transcribing', 'The RTX voice model is decoding your request.'],
  thinking: ['HERMES AGENT ACTIVE', 'Thinking', 'Hermes is reasoning about your request.'],
  working: ['TOOLS IN MOTION', 'Working', 'Hermes is operating on Picard.'],
  speaking: ['VOICE RESPONSE', 'Speaking', 'Audio response is playing.'],
  error: ['LINK EXCEPTION', 'Attention required', 'Check the activity display for details.']
};

function setState(state) {
  body.dataset.state = state;
  const [eyebrow,title,hint] = states[state] || states.idle;
  $('#eyebrow').textContent = eyebrow; $('#stateTitle').textContent = title; $('#stateHint').textContent = hint;
  $('#listenLabel').textContent = listening ? 'STOP LISTENING' : 'START LISTENING';
}
function addActivity(label, cls='') {
  if (activity.firstElementChild?.classList.contains('muted')) activity.innerHTML = '';
  const li = document.createElement('li'); li.textContent = label; li.className = cls; activity.prepend(li);
  while (activity.children.length > 12) activity.lastElementChild.remove();
  return li;
}
function addMessage(role, text='') {
  const article = document.createElement('article'); article.className = role;
  const who = document.createElement('span'); who.textContent = role === 'user' ? 'YOU' : 'HERMES';
  const p = document.createElement('p'); p.textContent = text;
  article.append(who,p); transcript.appendChild(article); transcript.scrollTop = transcript.scrollHeight;
  return article;
}
function sendPrompt(text) {
  text = text.trim(); if (!text || busy || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({type:'prompt', text})); busy = true; assistantArticle = null; assistantText = ''; setState('thinking');
}
function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => { $('#connectionText').textContent='LINKED'; $('#statusDot').style.background='var(--cyan)'; };
  socket.onclose = () => { $('#connectionText').textContent='RECONNECTING'; setState('connecting'); setTimeout(connect, 1800); };
  socket.onerror = () => setState('error');
  socket.onmessage = async ({data}) => {
    const event = JSON.parse(data), p = event.payload || {};
    if (event.type === 'ready') { $('#sessionLabel').textContent = p.session_id.slice(-12).toUpperCase(); $('#listenButton').disabled=false; setState('idle'); addActivity(`Session linked · ${p.workspace}`, 'done'); }
    else if (event.type === 'user.message') addMessage('user', p.content);
    else if (event.type === 'run.started') setState('thinking');
    else if (event.type === 'assistant.delta') {
      if (!assistantArticle) assistantArticle = addMessage('assistant');
      assistantText += p.delta || ''; assistantArticle.querySelector('p').textContent = assistantText; transcript.scrollTop = transcript.scrollHeight;
    } else if (event.type === 'tool.started') { setState('working'); addActivity(`${prettyTool(p.tool_name)} · ${p.preview || summarizeArgs(p.args) || 'started'}`); }
    else if (event.type === 'tool.completed') { addActivity(`${prettyTool(p.tool_name)} · complete`, 'done'); }
    else if (event.type === 'tool.failed') { addActivity(`${prettyTool(p.tool_name)} · failed`, 'failed'); }
    else if (event.type === 'assistant.completed') { assistantText = p.content || assistantText; if (!assistantArticle) assistantArticle=addMessage('assistant',assistantText); else assistantArticle.querySelector('p').textContent=assistantText; }
    else if (event.type === 'run.completed') { busy=false; await speakReply(assistantText); }
    else if (event.type === 'run.failed' || event.type === 'error') { busy=false; addActivity(p.message || p.error || 'Hermes turn failed','failed'); setState('error'); }
  };
}
function prettyTool(name='tool') { return name.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()); }
function summarizeArgs(args) { if (!args) return ''; const s=typeof args==='string'?args:JSON.stringify(args); return s.length>75?s.slice(0,72)+'…':s; }

async function ensureAudio() {
  if (audioContext) { if (audioContext.state === 'suspended') await audioContext.resume(); return; }
  stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  audioContext = new AudioContext(); source = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(1536,1,1); source.connect(processor); processor.connect(audioContext.destination);
  processor.onaudioprocess = ({inputBuffer}) => processAudio(inputBuffer.getChannelData(0));
}
function processAudio(frame) {
  if (!listening || speaking || busy) return;
  const samples = new Float32Array(frame); let energy=0; for (const x of samples) energy += x*x;
  const rms=Math.sqrt(energy/samples.length); core.style.setProperty('--audio-level',Math.min(1,rms/.11)); core.dataset.level=rms.toFixed(3);
  const duration=samples.length/audioContext.sampleRate*1000;
  if (!inSpeech) {
    preRoll.push(samples); while (preRoll.reduce((n,x)=>n+x.length,0) > audioContext.sampleRate*PRE_ROLL_MS/1000) preRoll.shift();
    if (rms > SPEECH_THRESHOLD) { inSpeech=true; utterance=[...preRoll,samples]; preRoll=[]; speechMs=duration; silenceMs=0; }
  } else {
    utterance.push(samples); speechMs += duration;
    if (rms > SPEECH_THRESHOLD*.72) silenceMs=0; else silenceMs += duration;
    if (silenceMs >= SILENCE_END_MS) finishUtterance();
  }
}
async function finishUtterance() {
  const frames=utterance; const duration=speechMs-silenceMs; utterance=[]; inSpeech=false; silenceMs=0; speechMs=0;
  if (duration < MIN_UTTERANCE_MS) return;
  setState('transcribing');
  try {
    const wav=encodeWav(frames,audioContext.sampleRate); const form=new FormData(); form.append('audio',wav,'utterance.wav');
    const response=await fetch('/api/transcribe',{method:'POST',body:form}); if(!response.ok) throw new Error(await response.text());
    const result=await response.json(); if(result.text) sendPrompt(result.text); else setState(listening?'listening':'idle');
  } catch(error) { addActivity(`Transcription · ${error.message}`,'failed'); setState('error'); }
}
function encodeWav(frames, sampleRate) {
  const length=frames.reduce((n,x)=>n+x.length,0), buffer=new ArrayBuffer(44+length*2), view=new DataView(buffer);
  const write=(o,s)=>[...s].forEach((c,i)=>view.setUint8(o+i,c.charCodeAt(0))); write(0,'RIFF'); view.setUint32(4,36+length*2,true); write(8,'WAVE'); write(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); write(36,'data'); view.setUint32(40,length*2,true);
  let o=44; for(const frame of frames) for(let x of frame){x=Math.max(-1,Math.min(1,x));view.setInt16(o,x<0?x*0x8000:x*0x7fff,true);o+=2;} return new Blob([view],{type:'audio/wav'});
}
async function toggleListening() {
  try { await ensureAudio(); listening=!listening; setState(listening?'listening':'idle'); addActivity(listening?'Microphone channel opened':'Microphone channel paused',listening?'':'done'); }
  catch(error){ addActivity(`Microphone · ${error.message}`,'failed'); setState('error'); }
}
async function speakReply(text) {
  if(!text){setState(listening?'listening':'idle');return;} speaking=true; setState('speaking');
  try { const response=await fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}); if(!response.ok) throw new Error(await response.text()); const url=URL.createObjectURL(await response.blob()); const audio=new Audio(url); await audio.play(); await new Promise(resolve=>{audio.onended=resolve;audio.onerror=resolve}); URL.revokeObjectURL(url); }
  catch(error){addActivity(`Voice · ${error.message}`,'failed');} finally {speaking=false;setState(listening?'listening':'idle');}
}
core.onclick=toggleListening; $('#listenButton').onclick=toggleListening;
$('#commandForm').onsubmit=(e)=>{e.preventDefault();const input=$('#commandInput');sendPrompt(input.value);input.value='';};
$('#newButton').onclick=()=>{transcript.innerHTML='';activity.innerHTML='<li class="muted">Display cleared.</li>';};
window.addEventListener('keydown',(e)=>{if(e.code==='Space' && !['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName)){e.preventDefault();toggleListening();}});
setInterval(()=>$('#clock').textContent=new Date().toLocaleTimeString('en-GB',{hour12:false}),1000);

// State-reactive background field: sparse geometry, not decorative fake metrics.
const canvas=$('#field'),ctx=canvas.getContext('2d');let particles=[];
function resize(){canvas.width=innerWidth*devicePixelRatio;canvas.height=innerHeight*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);particles=Array.from({length:52},()=>({x:Math.random()*innerWidth,y:Math.random()*innerHeight,v:.08+Math.random()*.18,r:.5+Math.random()*1.2}));} resize();addEventListener('resize',resize);
function draw(t){ctx.clearRect(0,0,innerWidth,innerHeight);const color=getComputedStyle(body).getPropertyValue('--state').trim()||'#63e8ff';ctx.strokeStyle=color+'18';ctx.lineWidth=.6;const cx=innerWidth*.38,cy=innerHeight*.42;for(let i=0;i<5;i++){ctx.beginPath();ctx.arc(cx,cy,190+i*68,(t/15000)*(i%2?1:-1)+i,(t/15000)*(i%2?1:-1)+i+Math.PI*(.3+i*.08));ctx.stroke();}ctx.fillStyle=color;for(const p of particles){p.y-=p.v;if(p.y<0)p.y=innerHeight;ctx.globalAlpha=.12+Math.sin(t/1000+p.x)*.08;ctx.fillRect(p.x,p.y,p.r,p.r);}ctx.globalAlpha=1;requestAnimationFrame(draw);}requestAnimationFrame(draw);connect();
