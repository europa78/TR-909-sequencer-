/**
 * TR-909 Sequencer — Application Logic v2
 * 
 * Per-instrument channel strip: Level, Tune, Decay, Cutoff, Resonance, Reverb Send, Delay Send
 * Master controls: Reverb (decay + wet), Delay (time + feedback + wet + tempo sync)
 */

const engine = new SequencerEngine();
let isInitialized = false;

async function initAudio() {
  if (isInitialized) return;
  await engine.init();
  isInitialized = true;
  await loadSynthesizedSamples();
  updateLCD('ENGINE READY + EFFECTS');
}

// ─── UI References ────────────────────────────────────────────

const PATTERN_NAMES = ['A','B','C','D','E','F','G','H'];
const grid = document.getElementById('instrument-grid');
const lcdDisplay = document.getElementById('lcd-display');
const playBtn = document.getElementById('btn-play');
const stopBtn = document.getElementById('btn-stop');
const presetSelect = document.getElementById('preset-select');
const delaySyncSelect = document.getElementById('delay-sync');
const midiInIndicator = document.getElementById('midi-in-indicator');
const midiOutIndicator = document.getElementById('midi-out-indicator');

const waveEditorInstLabel = document.getElementById('wave-editor-inst');
const waveEditorCanvas = document.getElementById('wave-editor-canvas');
const waveEditorReadout = document.getElementById('wave-editor-readout');
const hitThresholdSlider = document.getElementById('hit-threshold');
const hitThresholdValue = document.getElementById('hit-threshold-value');

let selectedInstrumentId = 'bd';
let waveEditorDragHandle = null;

// ─── MIDI Input (USB / USB‑C controllers) ─────────────────────

const MIDI_NOTE_TO_INST = {
  36: 'bd',   // Kick
  38: 'sd',   // Snare
  41: 'lt',   // Low tom
  45: 'mt',   // Mid tom
  48: 'ht',   // High tom
  37: 'rim',  // Rim shot
  39: 'clap', // Clap
  42: 'chh',  // Closed hat
  46: 'ohh',  // Open hat
  49: 'crash',// Crash
  51: 'ride', // Ride
};

let midiAccess = null;
let midiReady = false;
let midiInFlashTimer = null;
let midiOutFlashTimer = null;

const INST_TO_MIDI_NOTE = Object.fromEntries(Object.entries(MIDI_NOTE_TO_INST).map(([note, inst]) => [inst, Number(note)]));

async function initMIDI() {
  if (midiReady) return true;
  if (!navigator.requestMIDIAccess) {
    console.warn('[909] Web MIDI API not available in this runtime');
    return false;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiReady = true;
    bindMIDIInputs();
    midiAccess.onstatechange = () => {
      bindMIDIInputs();
      showMIDIStatus();
    };
    showMIDIStatus();
    console.log('[909] MIDI initialized');
    return true;
  } catch (err) {
    console.error('[909] MIDI init failed:', err);
    updateLCD('MIDI ACCESS DENIED');
    return false;
  }
}


function setMIDIIndicator(el, { enabled = false, connected = false, text = '' } = {}) {
  if (!el) return;
  el.classList.toggle('enabled', enabled);
  el.classList.toggle('connected', connected);
  if (text) el.textContent = text;
}

function flashMIDIIndicator(el, direction) {
  if (!el) return;
  el.classList.add('activity');
  if (direction === 'in') {
    clearTimeout(midiInFlashTimer);
    midiInFlashTimer = setTimeout(() => el.classList.remove('activity'), 120);
  } else {
    clearTimeout(midiOutFlashTimer);
    midiOutFlashTimer = setTimeout(() => el.classList.remove('activity'), 120);
  }
}

function sendMIDIToOutputs(bytes) {
  if (!midiAccess) return;
  let sent = false;
  for (const output of midiAccess.outputs.values()) {
    if (output.state !== 'connected') continue;
    output.send(bytes);
    sent = true;
  }
  if (sent) flashMIDIIndicator(midiOutIndicator, 'out');
}

function sendMIDINoteOut(instId, velocity = 100) {
  const note = INST_TO_MIDI_NOTE[instId];
  if (note === undefined) return;
  const vel = Math.max(1, Math.min(127, Math.round(velocity)));
  sendMIDIToOutputs([0x90, note, vel]);
  setTimeout(() => sendMIDIToOutputs([0x80, note, 0]), 80);
}

function sendMIDITransport(statusByte) {
  sendMIDIToOutputs([statusByte]);
}

function bindMIDIInputs() {
  if (!midiAccess) return;
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = onMIDIMessage;
  }
}

function showMIDIStatus() {
  const enabled = !!midiAccess;
  const inputs = enabled ? [...midiAccess.inputs.values()].filter(i => i.state === 'connected') : [];
  const outputs = enabled ? [...midiAccess.outputs.values()].filter(o => o.state === 'connected') : [];

  setMIDIIndicator(midiInIndicator, {
    enabled,
    connected: inputs.length > 0,
    text: inputs.length > 0 ? `MIDI IN ${inputs.length}` : 'MIDI IN'
  });
  setMIDIIndicator(midiOutIndicator, {
    enabled,
    connected: outputs.length > 0,
    text: outputs.length > 0 ? `MIDI OUT ${outputs.length}` : 'MIDI OUT'
  });

  if (inputs.length > 0 || outputs.length > 0) {
    updateLCD(`MIDI I/O ${inputs.length}/${outputs.length}`);
  }
}

async function onMIDIMessage(event) {
  flashMIDIIndicator(midiInIndicator, 'in');
  const [status, data1, data2] = event.data;

  // MIDI realtime transport messages
  if (status === 0xFA || status === 0xFB) {
    await initAudio();
    if (!engine.isPlaying) {
      engine.start();
      playBtn.classList.add('playing');
      updateLCD('MIDI START');
    }
    return;
  }
  if (status === 0xFC) {
    if (engine.isPlaying) {
      engine.stop();
      playBtn.classList.remove('playing');
      updateLCD('MIDI STOP');
    }
    return;
  }

  const type = status & 0xF0;
  const isNoteOn = type === 0x90 && data2 > 0;
  if (!isNoteOn) return;

  const instId = MIDI_NOTE_TO_INST[data1];
  if (!instId) return;

  await initAudio();
  const inst = engine.instruments[instId];
  if (!inst || !inst.buffer) return;

  const velocity = data2 >= 100 ? 2 : 1;
  engine._triggerSample(inst, engine.audioContext.currentTime, velocity);
  sendMIDINoteOut(instId, data2);
}


function getWaveEdit(instId) {
  const inst = engine.instruments[instId];
  if (!inst) return null;
  if (!inst.waveEdit) {
    inst.waveEdit = { start: 0, end: 1, threshold: 0.28, hitPoints: [] };
  }
  if (!Array.isArray(inst.waveEdit.hitPoints)) inst.waveEdit.hitPoints = [];
  return inst.waveEdit;
}

function detectHitPoints(instId) {
  const inst = engine.instruments[instId];
  if (!inst || !inst.buffer) return [];
  const waveEdit = getWaveEdit(instId);
  const data = inst.buffer.getChannelData(0);
  const startIdx = Math.floor(waveEdit.start * data.length);
  const endIdx = Math.max(startIdx + 2, Math.floor(waveEdit.end * data.length));
  const threshold = Math.max(0.02, Math.min(0.95, waveEdit.threshold || 0.28));

  const hits = [];
  let lastHit = -100000;
  const minGap = Math.max(120, Math.floor(inst.buffer.sampleRate * 0.012));

  for (let i = startIdx + 1; i < endIdx - 1; i++) {
    const a = Math.abs(data[i]);
    const prev = Math.abs(data[i - 1]);
    const next = Math.abs(data[i + 1]);
    if (a >= threshold && a >= prev && a > next && (i - lastHit) >= minGap) {
      hits.push(i / data.length);
      lastHit = i;
      if (hits.length > 64) break;
    }
  }

  waveEdit.hitPoints = hits;
  return hits;
}

function setSelectedInstrument(instId) {
  if (!engine.instruments[instId]) return;
  selectedInstrumentId = instId;
  document.querySelectorAll('.instrument-row').forEach((row) => {
    row.classList.toggle('selected', row.dataset.inst === instId);
  });
  refreshWaveEditor();
}

function refreshWaveEditor() {
  const inst = engine.instruments[selectedInstrumentId];
  if (!inst || !waveEditorCanvas) return;

  const waveEdit = getWaveEdit(selectedInstrumentId);
  detectHitPoints(selectedInstrumentId);

  waveEditorInstLabel.textContent = inst.shortName;
  hitThresholdSlider.value = Math.round((waveEdit.threshold || 0.28) * 100);
  hitThresholdValue.textContent = `${Math.round((waveEdit.threshold || 0.28) * 100)}%`;

  const ctx = waveEditorCanvas.getContext('2d');
  const w = waveEditorCanvas.width;
  const h = waveEditorCanvas.height;

  ctx.fillStyle = '#121812';
  ctx.fillRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const x = (w / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (!inst.buffer) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '14px Share Tech Mono';
    ctx.fillText('No sample loaded for this instrument', 18, h / 2 + 4);
    waveEditorReadout.textContent = 'START 0.0% · END 100.0% · HITS 0';
    return;
  }

  const data = inst.buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);

  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    let min = 1;
    let max = -1;
    const from = i * step;
    const to = Math.min(data.length, from + step);
    for (let j = from; j < to; j++) {
      if (data[j] < min) min = data[j];
      if (data[j] > max) max = data[j];
    }
    ctx.moveTo(i + 0.5, ((1 + min) * 0.5) * h);
    ctx.lineTo(i + 0.5, ((1 + max) * 0.5) * h);
  }
  ctx.strokeStyle = 'rgba(90,195,255,0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Active trim window
  const startX = waveEdit.start * w;
  const endX = waveEdit.end * w;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, 0, startX, h);
  ctx.fillRect(endX, 0, w - endX, h);

  // Hit points
  ctx.strokeStyle = 'rgba(255,200,60,0.9)';
  ctx.lineWidth = 1;
  for (const hp of waveEdit.hitPoints) {
    const x = hp * w;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.15);
    ctx.lineTo(x, h * 0.85);
    ctx.stroke();
  }

  function drawMarker(x, color, label) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 7, 0);
    ctx.lineTo(x + 7, 0);
    ctx.lineTo(x, 11);
    ctx.closePath();
    ctx.fill();

    ctx.font = '11px Share Tech Mono';
    ctx.fillText(label, Math.max(4, Math.min(w - 24, x + 8)), 14);
  }

  drawMarker(startX, 'rgba(80,210,120,0.98)', 'S');
  drawMarker(endX, 'rgba(255,95,95,0.98)', 'E');

  waveEditorReadout.textContent = `START ${(waveEdit.start * 100).toFixed(1)}% · END ${(waveEdit.end * 100).toFixed(1)}% · HITS ${waveEdit.hitPoints.length}`;
}

function setupWaveEditorInteraction() {
  if (!waveEditorCanvas) return;

  const getNormX = (event) => {
    const rect = waveEditorCanvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  };

  waveEditorCanvas.addEventListener('pointerdown', (event) => {
    const waveEdit = getWaveEdit(selectedInstrumentId);
    if (!waveEdit) return;
    waveEditorCanvas.setPointerCapture(event.pointerId);
    const x = getNormX(event);
    const dStart = Math.abs(x - waveEdit.start);
    const dEnd = Math.abs(x - waveEdit.end);
    waveEditorDragHandle = dStart <= dEnd ? 'start' : 'end';
  });

  waveEditorCanvas.addEventListener('pointermove', (event) => {
    if (!waveEditorDragHandle) return;
    const waveEdit = getWaveEdit(selectedInstrumentId);
    if (!waveEdit) return;
    const x = getNormX(event);
    if (waveEditorDragHandle === 'start') {
      waveEdit.start = Math.max(0, Math.min(waveEdit.end - 0.01, x));
    } else {
      waveEdit.end = Math.max(waveEdit.start + 0.01, Math.min(1, x));
    }
    refreshWaveEditor();
  });

  const stopDrag = () => { waveEditorDragHandle = null; };
  waveEditorCanvas.addEventListener('pointerup', stopDrag);
  waveEditorCanvas.addEventListener('pointercancel', stopDrag);

  hitThresholdSlider.addEventListener('input', () => {
    const waveEdit = getWaveEdit(selectedInstrumentId);
    if (!waveEdit) return;
    waveEdit.threshold = Number(hitThresholdSlider.value) / 100;
    refreshWaveEditor();
  });
}

// ─── Build Instrument Grid ────────────────────────────────────

function buildGrid() {
  grid.innerHTML = '';
  const instrumentOrder = ['bd','sd','lt','mt','ht','rim','clap','chh','ohh','crash','ride'];

  for (const instId of instrumentOrder) {
    const inst = engine.instruments[instId];
    const row = document.createElement('div');
    row.className = 'instrument-row';
    row.dataset.inst = instId;

    const cc = inst.color === '#e84030' ? 'red' : inst.color === '#e8a030' ? 'orange' : inst.color === '#e8d830' ? 'yellow' : 'blue';
    const colorClass = 'color-' + cc;

    // ── Label ──
    const label = document.createElement('div');
    label.className = 'inst-label';
    label.innerHTML = `<span class="inst-color" style="background:${inst.color}"></span><span class="inst-name" style="color:${inst.color}">${inst.shortName}</span>`;
    label.title = `${inst.shortName}: click to load sample, Shift+click to preview`;
    label.addEventListener('click', async (e) => {
      if (e.shiftKey) {
        await previewInstrument(instId);
        return;
      }
      setSelectedInstrument(instId);
      if (e.metaKey || e.ctrlKey) await loadSampleForInstrument(instId);
    });
    row.appendChild(label);

    // ── Waveform Display ──
    const wfContainer = document.createElement('div');
    wfContainer.className = 'waveform-container';
    wfContainer.dataset.inst = instId;

    const wfCanvas = document.createElement('canvas');
    wfCanvas.width = 128;
    wfCanvas.height = 76;
    wfContainer.appendChild(wfCanvas);

    const wfHint = document.createElement('div');
    wfHint.className = 'wf-hint';
    wfHint.textContent = 'DROP';
    wfContainer.appendChild(wfHint);

    const wfName = document.createElement('div');
    wfName.className = 'wf-name';
    wfName.dataset.inst = instId;
    wfContainer.appendChild(wfName);

    wfContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelectedInstrument(instId);
    });

    wfContainer.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      await loadSampleForInstrument(instId);
    });

    row.appendChild(wfContainer);

    // ── Channel Strip ──
    const controls = document.createElement('div');
    controls.className = 'inst-controls';

    // Knob definitions: [param, label, min, max, default, displayFn, extraClass]
    const knobDefs = [
      ['level',        'LVL',  0, 100, Math.round(inst.level * 100), v => v, ''],
      ['tune',         'TUN', -12, 12, inst.tune, v => (v > 0 ? '+' : '') + v, ''],
      ['decay',        'DCY',  10, 200, Math.round(inst.decay * 100), v => v, ''],
      ['filterCutoff', 'CUT',  100, 20000, inst.filterCutoff, v => v >= 15000 ? 'OFF' : (v >= 1000 ? (v/1000).toFixed(1)+'k' : v), ''],
      ['filterRes',    'RES',  0, 25, Math.round(inst.filterRes), v => v, ''],
    ];

    // Divider before sends
    const sendDefs = [
      ['reverbSend',  'REV',  0, 100, Math.round(inst.reverbSend * 100), v => v, 'rev'],
      ['delaySend',   'DLY',  0, 100, Math.round(inst.delaySend * 100), v => v, 'dly'],
    ];

    for (const [param, lbl, min, max, defVal, displayFn, cls] of knobDefs) {
      const group = document.createElement('div');
      group.className = 'mini-knob-group';

      const knobLabel = document.createElement('span');
      knobLabel.className = 'mk-label';
      knobLabel.textContent = lbl;
      group.appendChild(knobLabel);

      const knob = document.createElement('div');
      knob.className = 'mini-knob';
      knob.dataset.inst = instId;
      knob.dataset.param = param;
      knob.dataset.min = String(min);
      knob.dataset.max = String(max);
      knob.dataset.value = String(defVal);
      knob.dataset.displayFn = displayFn.toString();
      knob.title = `${inst.shortName} ${lbl}`;
      group.appendChild(knob);

      controls.appendChild(group);
    }

    // Separator before sends
    const sep = document.createElement('div');
    sep.className = 'knob-divider';
    controls.appendChild(sep);

    for (const [param, lbl, min, max, defVal, displayFn, cls] of sendDefs) {
      const group = document.createElement('div');
      group.className = 'mini-knob-group';

      const knobLabel = document.createElement('span');
      knobLabel.className = `mk-label ${cls}-label`;
      knobLabel.textContent = lbl;
      group.appendChild(knobLabel);

      const knob = document.createElement('div');
      knob.className = `mini-knob ${cls}-knob`;
      knob.dataset.inst = instId;
      knob.dataset.param = param;
      knob.dataset.min = String(min);
      knob.dataset.max = String(max);
      knob.dataset.value = String(defVal);
      knob.title = `${inst.shortName} ${lbl} Send`;
      group.appendChild(knob);

      controls.appendChild(group);
    }

    // Mute / Solo
    const ms = document.createElement('div');
    ms.className = 'knob-divider';
    controls.appendChild(ms);

    const muteBtn = document.createElement('button');
    muteBtn.className = 'mute-btn';
    muteBtn.textContent = 'M';
    muteBtn.addEventListener('click', () => {
      inst.muted = !inst.muted;
      muteBtn.classList.toggle('active', inst.muted);
    });
    controls.appendChild(muteBtn);

    const soloBtn = document.createElement('button');
    soloBtn.className = 'solo-btn';
    soloBtn.textContent = 'S';
    soloBtn.addEventListener('click', () => {
      inst.soloed = !inst.soloed;
      soloBtn.classList.toggle('active', inst.soloed);
    });
    controls.appendChild(soloBtn);

    row.appendChild(controls);

    // ── Steps ──
    const stepsContainer = document.createElement('div');
    stepsContainer.className = 'steps-container';

    for (let g = 0; g < 4; g++) {
      const stepGroup = document.createElement('div');
      stepGroup.className = 'step-group';
      for (let i = 0; i < 4; i++) {
        const step = g * 4 + i;
        const btn = document.createElement('button');
        btn.className = `step-btn off ${colorClass}`;
        btn.dataset.inst = instId;
        btn.dataset.step = step;
        btn.addEventListener('click', () => {
          const v = engine.toggleStep(instId, step);
          btn.className = v === 0 ? `step-btn off ${colorClass}` : v === 1 ? `step-btn active ${colorClass}` : `step-btn accent ${colorClass}`;
        });
        btn.addEventListener('contextmenu', e => {
          e.preventDefault();
          engine.setStep(instId, step, 0);
          btn.className = `step-btn off ${colorClass}`;
        });
        stepGroup.appendChild(btn);
      }
      stepsContainer.appendChild(stepGroup);
    }

    row.appendChild(stepsContainer);

    row.addEventListener('click', () => setSelectedInstrument(instId));

    // ── Drag & Drop per row ──
    setupRowDragDrop(row, instId);

    grid.appendChild(row);
  }

  // Setup all mini knobs after DOM is built
  document.querySelectorAll('.mini-knob').forEach(setupMiniKnob);
  setSelectedInstrument(selectedInstrumentId);
}

// ─── Step Highlight ───────────────────────────────────────────

let prevStep = -1;

engine.onStepChange = (step) => {
  if (prevStep >= 0) document.querySelectorAll(`.step-btn[data-step="${prevStep}"]`).forEach(b => b.classList.remove('current'));
  document.querySelectorAll(`.step-btn[data-step="${step}"]`).forEach(b => b.classList.add('current'));
  prevStep = step;
  const beat = Math.floor(step / 4) + 1, sub = (step % 4) + 1;
  const patLabel = PATTERN_NAMES[engine.activePatternIndex];
  if (engine.chainMode && engine.chain.length > 0) {
    updateLCD(`${beat}.${sub}  |  ${engine.tempo} BPM  |  CHAIN ${engine.chainPosition + 1}/${engine.chain.length} [${patLabel}]`);
  } else {
    const pending = engine.pendingPatternIndex >= 0 ? ` → ${PATTERN_NAMES[engine.pendingPatternIndex]}` : '';
    updateLCD(`${beat}.${sub}  |  ${engine.tempo} BPM  |  PAT ${patLabel}${pending}`);
  }
};

engine.onStop = () => {
  document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('current'));
  prevStep = -1;
  playBtn.classList.remove('playing');
  refreshBankButtons();
  updateLCD('STOPPED');
};

// ─── Transport ────────────────────────────────────────────────

playBtn.addEventListener('click', async () => {
  await initAudio();
  await initMIDI();
  if (engine.isPlaying) { engine.stop(); playBtn.classList.remove('playing'); sendMIDITransport(0xFC); }
  else { engine.start(); playBtn.classList.add('playing'); sendMIDITransport(0xFA); }
});

stopBtn.addEventListener('click', () => { engine.stop(); playBtn.classList.remove('playing'); sendMIDITransport(0xFC); });

document.addEventListener('keydown', async (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    await initAudio();
    await initMIDI();
    if (engine.isPlaying) { engine.stop(); playBtn.classList.remove('playing'); sendMIDITransport(0xFC); }
    else { engine.start(); playBtn.classList.add('playing'); sendMIDITransport(0xFA); }
  }

  // Number keys 1-8 for pattern bank
  const num = parseInt(e.key);
  if (num >= 1 && num <= 8 && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const idx = num - 1;
    if (engine.isPlaying) {
      engine.pendingPatternIndex = idx;
      updateLCD(`QUEUED: PAT ${PATTERN_NAMES[idx]}`);
    } else {
      engine.loadFromBank(idx);
      refreshGrid();
      updateLCD(`PAT ${PATTERN_NAMES[idx]}`);
    }
    refreshBankButtons();
  }

  // C key = copy, V key = paste
  if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.repeat) {
    engine.copyPattern();
    updateLCD(`COPIED PAT ${PATTERN_NAMES[engine.activePatternIndex]}`);
  }
  if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey && !e.repeat) {
    if (engine.pastePattern()) {
      refreshGrid();
      refreshBankButtons();
      updateLCD(`PASTED → PAT ${PATTERN_NAMES[engine.activePatternIndex]}`);
    }
  }
});

// ─── Knob Interaction ─────────────────────────────────────────

function setupKnob(el) {
  let drag = false, sy = 0, sv = 0;
  const min = +el.dataset.min, max = +el.dataset.max;
  let val = +el.dataset.value;

  const upd = () => { el.style.transform = `rotate(${-135 + ((val - min) / (max - min)) * 270}deg)`; };
  upd();

  el.addEventListener('mousedown', e => { drag = true; sy = e.clientY; sv = val; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    val = Math.round(Math.max(min, Math.min(max, sv + (sy - e.clientY) * ((max - min) / 200))));
    el.dataset.value = val; upd();
    onMasterKnobChange(el.id, val);
  });
  document.addEventListener('mouseup', () => { drag = false; });

  el.addEventListener('wheel', e => {
    e.preventDefault();
    const step = Math.max(1, Math.round((max - min) / 100));
    val = Math.round(Math.max(min, Math.min(max, val + (e.deltaY < 0 ? step : -step))));
    el.dataset.value = val; upd();
    onMasterKnobChange(el.id, val);
  });
}

function onMasterKnobChange(id, v) {
  switch (id) {
    case 'knob-tempo':
      engine.setTempo(v);
      document.getElementById('val-tempo').textContent = v;
      // Re-sync delay if synced
      syncDelayIfNeeded();
      break;
    case 'knob-swing':
      engine.setSwing(v);
      document.getElementById('val-swing').textContent = v;
      break;
    case 'knob-volume':
      engine.setMasterVolume(v / 100);
      document.getElementById('val-volume').textContent = v;
      break;
    case 'knob-rev-decay':
      engine.setReverbDecay(v / 10);
      document.getElementById('val-rev-decay').textContent = (v / 10).toFixed(1) + 's';
      break;
    case 'knob-rev-wet':
      engine.setReverbWet(v / 100);
      document.getElementById('val-rev-wet').textContent = v;
      break;
    case 'knob-dly-time':
      engine.setDelayTime(v / 1000);
      document.getElementById('val-dly-time').textContent = v + 'ms';
      // Unsync when manually adjusting time
      delaySyncSelect.value = '';
      break;
    case 'knob-dly-fb':
      engine.setDelayFeedback(v / 100);
      document.getElementById('val-dly-fb').textContent = v;
      break;
    case 'knob-dly-wet':
      engine.setDelayWet(v / 100);
      document.getElementById('val-dly-wet').textContent = v;
      break;
  }
}

// ─── Mini Knob (per-instrument) ───────────────────────────────

function setupMiniKnob(el) {
  let drag = false, sy = 0, sv = 0;
  const min = +el.dataset.min, max = +el.dataset.max;
  let val = +el.dataset.value;
  const instId = el.dataset.inst;
  const param = el.dataset.param;

  const upd = () => { el.style.transform = `rotate(${-135 + ((val - min) / (max - min)) * 270}deg)`; };
  upd();

  el.addEventListener('mousedown', e => { drag = true; sy = e.clientY; sv = val; e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    const sensitivity = (max - min) > 1000 ? 400 : 150;
    val = Math.round(Math.max(min, Math.min(max, sv + (sy - e.clientY) * ((max - min) / sensitivity))));
    el.dataset.value = val; upd();
    applyMiniKnob(instId, param, val);
  });
  document.addEventListener('mouseup', () => { drag = false; });

  el.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    const step = (max - min) > 1000 ? 200 : (max - min) > 100 ? 5 : 1;
    val = Math.round(Math.max(min, Math.min(max, val + (e.deltaY < 0 ? step : -step))));
    el.dataset.value = val; upd();
    applyMiniKnob(instId, param, val);
  });
}

function applyMiniKnob(instId, param, rawVal) {
  let engineVal;
  switch (param) {
    case 'level':
      engineVal = rawVal / 100;
      break;
    case 'tune':
      engineVal = rawVal; // already -12 to 12
      break;
    case 'decay':
      engineVal = rawVal / 100; // 10-200 → 0.1-2.0
      break;
    case 'filterCutoff':
      engineVal = rawVal; // 100-20000 Hz
      break;
    case 'filterRes':
      engineVal = rawVal; // 0-25
      break;
    case 'reverbSend':
    case 'delaySend':
      engineVal = rawVal / 100;
      break;
    default:
      engineVal = rawVal;
  }
  engine.setInstrumentParam(instId, param, engineVal);
}

// ─── Delay Sync ───────────────────────────────────────────────

delaySyncSelect.addEventListener('change', () => syncDelayIfNeeded());

function syncDelayIfNeeded() {
  const div = delaySyncSelect.value;
  if (!div) return;
  const t = engine.syncDelayToTempo(div);
  const ms = Math.round(t * 1000);
  document.getElementById('val-dly-time').textContent = ms + 'ms';
  const timeKnob = document.getElementById('knob-dly-time');
  timeKnob.dataset.value = ms;
  // Update knob rotation
  const min = +timeKnob.dataset.min, max = +timeKnob.dataset.max;
  const pct = (ms - min) / (max - min);
  timeKnob.style.transform = `rotate(${-135 + pct * 270}deg)`;
}

// ─── Preset ───────────────────────────────────────────────────

presetSelect.addEventListener('change', (e) => {
  const name = e.target.value;
  if (!name) { engine.clearPattern(); refreshGrid(); refreshBankButtons(); updateLCD('CLEARED'); return; }

  if (engine.loadPreset(name)) {
    refreshGrid();
    refreshAllKnobs();
    refreshBankButtons();
    updateLCD('LOADED: ' + name.toUpperCase());
  }
});

function refreshGrid() {
  for (const [instId, inst] of Object.entries(engine.instruments)) {
    const cc = inst.color === '#e84030' ? 'red' : inst.color === '#e8a030' ? 'orange' : inst.color === '#e8d830' ? 'yellow' : 'blue';
    for (let s = 0; s < 16; s++) {
      const btn = document.querySelector(`.step-btn[data-inst="${instId}"][data-step="${s}"]`);
      if (!btn) continue;
      const v = inst.pattern[s];
      btn.className = v === 0 ? `step-btn off color-${cc}` : v === 1 ? `step-btn active color-${cc}` : `step-btn accent color-${cc}`;
    }
  }
}

function refreshAllKnobs() {
  // Master knobs
  const tk = document.getElementById('knob-tempo'); tk.dataset.value = engine.tempo; setupKnob(tk);
  document.getElementById('val-tempo').textContent = engine.tempo;
  const sk = document.getElementById('knob-swing'); sk.dataset.value = engine.swing; setupKnob(sk);
  document.getElementById('val-swing').textContent = engine.swing;

  // Per-instrument mini knobs
  for (const [instId, inst] of Object.entries(engine.instruments)) {
    const paramMap = {
      level: Math.round(inst.level * 100),
      tune: inst.tune,
      decay: Math.round(inst.decay * 100),
      filterCutoff: inst.filterCutoff,
      filterRes: Math.round(inst.filterRes),
      reverbSend: Math.round(inst.reverbSend * 100),
      delaySend: Math.round(inst.delaySend * 100),
    };

    for (const [param, val] of Object.entries(paramMap)) {
      const knob = document.querySelector(`.mini-knob[data-inst="${instId}"][data-param="${param}"]`);
      if (knob) {
        knob.dataset.value = val;
        const min = +knob.dataset.min, max = +knob.dataset.max;
        const pct = (val - min) / (max - min);
        knob.style.transform = `rotate(${-135 + pct * 270}deg)`;
      }
    }
  }
}

// ─── Sample Management ────────────────────────────────────────

const sampleOverlay = document.getElementById('sample-overlay');
const sampleSlots = document.getElementById('sample-slots');

document.getElementById('btn-load-samples').addEventListener('click', () => { buildSampleSlots(); sampleOverlay.classList.add('visible'); });
document.getElementById('btn-close-samples').addEventListener('click', () => { sampleOverlay.classList.remove('visible'); });

document.getElementById('btn-load-kit').addEventListener('click', async () => {
  await initAudio();
  if (!window.electronAPI) return;
  const files = await window.electronAPI.loadSamplesDir();
  if (!files) return;

  const keywords = {
    bd:['kick','bass','bd','bassdrum'], sd:['snare','sd','snr'], lt:['low','lt','lowtom'], mt:['mid','mt','midtom'],
    ht:['hi','ht','hitom','high'], rim:['rim','rimshot'], clap:['clap','cp','handclap'],
    chh:['closed','chh','ch','closedhat'], ohh:['open','ohh','oh','openhat'], crash:['crash','cr'], ride:['ride','rd'],
  };

  for (const file of files) {
    const lower = file.name.toLowerCase();
    for (const [instId, keys] of Object.entries(keywords)) {
      if (keys.some(k => lower.includes(k))) {
        const buf = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
        const loaded = await engine.loadSample(instId, buf);
        if (loaded) setInstrumentSampleMeta(instId, file.name, file.path);
        break;
      }
    }
  }
  updateLCD(`KIT: ${files.length} SAMPLES`);
  buildSampleSlots();
  drawAllWaveforms();
  refreshWaveEditor();
});

function buildSampleSlots() {
  sampleSlots.innerHTML = '';
  for (const [id, inst] of Object.entries(engine.instruments)) {
    const slot = document.createElement('div');
    slot.className = 'sample-slot';
    slot.innerHTML = `<span class="slot-name" style="color:${inst.color}">${inst.shortName} — ${inst.name}</span><span class="slot-file ${inst.buffer ? 'slot-loaded' : ''}">${inst.buffer ? '● loaded' : '○ empty'}</span>`;
    slot.addEventListener('click', async () => {
      await initAudio();
      if (!window.electronAPI) return;
      const file = await window.electronAPI.loadSampleFile();
      if (file) {
        const buf = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
        await engine.loadSample(id, buf);
        buildSampleSlots();
        drawWaveform(id);
        refreshWaveEditor();
        const nameEl = document.querySelector(`.wf-name[data-inst="${id}"]`);
        if (nameEl) nameEl.textContent = file.name;
        setInstrumentSampleMeta(id, file.name, file.path);
        updateLCD(`${inst.shortName}: ${file.name}`);
      }
    });
    sampleSlots.appendChild(slot);
  }
}

// ─── Save / Load / Clear ──────────────────────────────────────

async function saveSessionToDisk(sessionData) {
  if (window.electronAPI) {
    const saved = await window.electronAPI.savePattern(sessionData);
    return !!saved;
  }

  // Browser fallback: download JSON
  const blob = new Blob([JSON.stringify(sessionData, null, 2)], { type: 'application/json' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tr909-session-${ts}.909`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
  return true;
}

async function loadSessionFromDisk() {
  if (window.electronAPI) {
    return await window.electronAPI.loadPattern();
  }

  // Browser fallback: choose local JSON file
  return await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.909,.json,application/json';
    input.onchange = async (e) => {
      try {
        const file = e.target.files?.[0];
        if (!file) return resolve(null);
        const text = await file.text();
        resolve(JSON.parse(text));
      } catch (err) {
        console.error('[909] Failed to parse session file:', err);
        resolve(null);
      }
    };
    input.click();
  });
}

document.getElementById('btn-save').addEventListener('click', async () => {
  try {
    const saved = await saveSessionToDisk(engine.serialize());
    updateLCD(saved ? 'SESSION SAVED' : 'SAVE CANCELED');
  } catch (err) {
    console.error('[909] Save failed:', err);
    updateLCD('SAVE FAILED');
  }
});

document.getElementById('btn-load').addEventListener('click', async () => {
  try {
    const data = await loadSessionFromDisk();
    if (!data) {
      updateLCD('LOAD CANCELED');
      return;
    }

    engine.deserialize(data);
    refreshGrid();
    refreshAllKnobs();
    refreshBankButtons();
    const missing = await restoreSessionSamples(data);
    refreshWaveEditor();
    updateLCD(missing.length > 0 ? `SESSION LOADED (missing: ${missing.join(', ')})` : 'SESSION LOADED');
  } catch (err) {
    console.error('[909] Load failed:', err);
    updateLCD('LOAD FAILED');
  }
});

document.getElementById('btn-clear').addEventListener('click', () => {
  engine.clearAllPatterns();
  refreshGrid();
  refreshAllKnobs();
  presetSelect.value = '';
  refreshBankButtons();
  updateLCD('ALL PATTERNS CLEARED');
});

// ─── Preview ──────────────────────────────────────────────────

async function previewInstrument(instId) {
  await initAudio();
  const inst = engine.instruments[instId];
  if (inst.buffer) engine._triggerSample(inst, engine.audioContext.currentTime, 1);
}

// ─── LCD ──────────────────────────────────────────────────────

function updateLCD(text) { lcdDisplay.textContent = text; }

function setInstrumentSampleMeta(instId, sampleName, samplePath = null) {
  const inst = engine.instruments[instId];
  if (!inst) return;
  inst._sampleName = sampleName || null;
  inst._samplePath = samplePath || null;
  inst.sampleName = sampleName || null;
  inst.samplePath = samplePath || null;
}

async function restoreSessionSamples(sessionData) {
  if (!window.electronAPI || !sessionData || !sessionData.instruments) return [];

  const failed = [];
  for (const [instId, data] of Object.entries(sessionData.instruments)) {
    if (!engine.instruments[instId]) continue;
    if (!data || !data.samplePath) continue;

    const file = await window.electronAPI.loadSamplePath(data.samplePath);
    if (!file) {
      failed.push(instId.toUpperCase());
      continue;
    }

    const buf = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
    const success = await engine.loadSample(instId, buf);
    if (!success) {
      failed.push(instId.toUpperCase());
      continue;
    }

    setInstrumentSampleMeta(instId, file.name, file.path);
    const nameEl = document.querySelector(`.wf-name[data-inst="${instId}"]`);
    if (nameEl) nameEl.textContent = file.name;
    drawWaveform(instId);
  }

  return failed;
}

// ─── Synthesized Fallback Samples ─────────────────────────────

async function loadSynthesizedSamples() {
  const ctx = engine.audioContext;
  const sr = ctx.sampleRate;

  function synthBuf(dur, fn) {
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = fn(i / sr);
    return buf;
  }

  engine.instruments.bd.buffer = synthBuf(0.5, t => Math.sin(2*Math.PI*(150*Math.exp(-t*40)+45)*t)*Math.exp(-t*6)*0.9);
  engine.instruments.sd.buffer = synthBuf(0.3, t => Math.sin(2*Math.PI*200*t)*Math.exp(-t*20)*0.5+(Math.random()*2-1)*Math.exp(-t*12)*0.6);
  engine.instruments.lt.buffer = synthBuf(0.35, t => Math.sin(2*Math.PI*(100*Math.exp(-t*20)+60)*t)*Math.exp(-t*8)*0.7);
  engine.instruments.mt.buffer = synthBuf(0.3, t => Math.sin(2*Math.PI*(120*Math.exp(-t*22)+90)*t)*Math.exp(-t*10)*0.7);
  engine.instruments.ht.buffer = synthBuf(0.25, t => Math.sin(2*Math.PI*(140*Math.exp(-t*25)+120)*t)*Math.exp(-t*12)*0.7);
  engine.instruments.rim.buffer = synthBuf(0.1, t => Math.sin(2*Math.PI*800*t)*Math.exp(-t*80)*0.7);
  engine.instruments.clap.buffer = synthBuf(0.2, t => { const n=Math.random()*2-1; return n*((t<0.01?1:0)+((t>0.015&&t<0.025)?1:0)+((t>0.03&&t<0.04)?1:0)+(t>0.04?Math.exp(-(t-0.04)*20):0))*0.6; });
  engine.instruments.chh.buffer = synthBuf(0.08, t => (Math.random()*2-1-(Math.random()*2-1)*0.3)*Math.exp(-t*60)*0.5);
  engine.instruments.ohh.buffer = synthBuf(0.4, t => (Math.random()*2-1-(Math.random()*2-1)*0.3)*Math.exp(-t*8)*0.5);
  engine.instruments.crash.buffer = synthBuf(1.5, t => ((Math.random()*2-1)*0.5+Math.sin(2*Math.PI*3500*t)*0.15+Math.sin(2*Math.PI*5200*t)*0.1)*Math.exp(-t*2.5)*0.4);
  engine.instruments.ride.buffer = synthBuf(0.8, t => ((Math.random()*2-1)*0.2+Math.sin(2*Math.PI*4500*t)*0.3+Math.sin(2*Math.PI*6800*t)*0.15)*Math.exp(-t*3)*0.4);

  updateLCD('SYNTH KIT + FX LOADED');

  // Draw waveforms for all loaded synth samples
  setTimeout(() => { drawAllWaveforms(); refreshWaveEditor(); }, 50);
}

// ─── Waveform Drawing ────────────────────────────────────────

function drawWaveform(instId) {
  const inst = engine.instruments[instId];
  const container = document.querySelector(`.waveform-container[data-inst="${instId}"]`);
  if (!container) return;

  const canvas = container.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  // Clear
  ctx.fillStyle = '#1a1e1a';
  ctx.fillRect(0, 0, w, h);

  if (!inst.buffer) {
    container.classList.remove('has-sample');
    return;
  }

  container.classList.add('has-sample');

  // Get audio data (use first channel)
  const data = inst.buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);

  // Determine color based on instrument
  const color = inst.color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  // Draw filled waveform
  ctx.beginPath();
  ctx.moveTo(0, h / 2);

  for (let i = 0; i < w; i++) {
    let min = 1.0, max = -1.0;
    const start = i * step;
    const end = Math.min(start + step, data.length);
    for (let j = start; j < end; j++) {
      if (data[j] < min) min = data[j];
      if (data[j] > max) max = data[j];
    }
    const yMin = ((1 + min) / 2) * h;
    const yMax = ((1 + max) / 2) * h;
    ctx.lineTo(i, yMax);
  }

  // Come back along the bottom (min values)
  for (let i = w - 1; i >= 0; i--) {
    let min = 1.0;
    const start = i * step;
    const end = Math.min(start + step, data.length);
    for (let j = start; j < end; j++) {
      if (data[j] < min) min = data[j];
    }
    const yMin = ((1 + min) / 2) * h;
    ctx.lineTo(i, yMin);
  }

  ctx.closePath();

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0.6)`);
  ctx.fillStyle = grad;
  ctx.fill();

  // Center line
  ctx.strokeStyle = `rgba(${r},${g},${b},0.3)`;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function drawAllWaveforms() {
  for (const instId of Object.keys(engine.instruments)) {
    drawWaveform(instId);
  }
}

// ─── Drag & Drop ─────────────────────────────────────────────

const dropOverlay = document.getElementById('drop-zone-overlay');
let globalDragCounter = 0;

// Global drag indicators
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  globalDragCounter++;
  if (globalDragCounter === 1) {
    dropOverlay.classList.add('visible');
  }
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  globalDragCounter--;
  if (globalDragCounter <= 0) {
    globalDragCounter = 0;
    dropOverlay.classList.remove('visible');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  globalDragCounter = 0;
  dropOverlay.classList.remove('visible');
});

function setupRowDragDrop(row, instId) {
  let rowDragCounter = 0;

  row.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    rowDragCounter++;
    row.classList.add('drag-over');
  });

  row.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    rowDragCounter--;
    if (rowDragCounter <= 0) {
      rowDragCounter = 0;
      row.classList.remove('drag-over');
    }
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    rowDragCounter = 0;
    row.classList.remove('drag-over');
    globalDragCounter = 0;
    dropOverlay.classList.remove('visible');

    await initAudio();

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (/\.(wav|mp3|ogg|flac|aif|aiff)$/i.test(file.name)) {
        await handleDroppedFile(instId, file);
      } else {
        updateLCD('ERROR: NOT AN AUDIO FILE');
      }
    }
  });
}

async function handleDroppedFile(instId, file) {
  const inst = engine.instruments[instId];

  try {
    const arrayBuffer = await file.arrayBuffer();
    const success = await engine.loadSample(instId, arrayBuffer);

    if (success) {
      // Store the filename for display
      setInstrumentSampleMeta(instId, file.name, file.path || null);

      // Update waveform
      drawWaveform(instId);
      refreshWaveEditor();

      // Update the name label
      const nameEl = document.querySelector(`.wf-name[data-inst="${instId}"]`);
      if (nameEl) nameEl.textContent = file.name;

      updateLCD(`${inst.shortName}: ${file.name}`);
    } else {
      updateLCD(`ERR: DECODE FAILED`);
    }
  } catch (err) {
    console.error('[909] Drop error:', err);
    updateLCD('ERROR: LOAD FAILED');
  }
}

// ─── File Picker (click on waveform) ─────────────────────────

async function loadSampleForInstrument(instId) {
  await initAudio();

  // In Electron, use the native dialog
  if (window.electronAPI) {
    const file = await window.electronAPI.loadSampleFile();
    if (file) {
      const buf = file.buffer.buffer.slice(
        file.buffer.byteOffset,
        file.buffer.byteOffset + file.buffer.byteLength
      );
      const success = await engine.loadSample(instId, buf);
      if (success) {
        const inst = engine.instruments[instId];
        setInstrumentSampleMeta(instId, file.name, file.path || null);
        drawWaveform(instId);
        refreshWaveEditor();
        const nameEl = document.querySelector(`.wf-name[data-inst="${instId}"]`);
        if (nameEl) nameEl.textContent = file.name;
        updateLCD(`${inst.shortName}: ${file.name}`);
      }
    }
    return;
  }

  // In browser, use a hidden file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.mp3,.ogg,.flac,.aif,.aiff';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (file) {
      await handleDroppedFile(instId, file);
    }
  };
  input.click();
}

// ─── WAV Export ──────────────────────────────────────────────

const exportOverlay = document.getElementById('export-overlay');
const exportProgressWrap = document.getElementById('export-progress-wrap');
const exportProgressFill = document.getElementById('export-progress-fill');
const exportProgressText = document.getElementById('export-progress-text');
const exportGoBtn = document.getElementById('btn-export-go');

let exportLoops = 2;
let exportTail = 2.0;
let exportMode = 'pattern'; // 'pattern' or 'chain'
let exportBusy = false;

function updateExportDurationHint() {
  const barDur = (60.0 / engine.tempo) * 4;
  let totalBars;
  if (exportMode === 'chain' && engine.chain.length > 0) {
    totalBars = engine.chain.length * exportLoops;
  } else {
    totalBars = exportLoops;
  }
  const dur = totalBars * barDur + exportTail;
  document.getElementById('export-duration-hint').textContent = `≈ ${dur.toFixed(1)}s`;
}

document.getElementById('btn-export').addEventListener('click', async () => {
  await initAudio();

  // Reset state
  exportBusy = false;
  exportGoBtn.disabled = false;
  exportGoBtn.textContent = 'RENDER & DOWNLOAD';
  exportProgressWrap.classList.remove('visible');
  exportProgressFill.style.width = '0%';

  // Chain button enabled only if chain has patterns
  const chainBtn = document.querySelector('.export-toggle-btn[data-value="chain"]');
  if (engine.chain.length === 0) {
    chainBtn.disabled = true;
    if (exportMode === 'chain') {
      exportMode = 'pattern';
      document.querySelectorAll('.export-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === exportMode);
      });
    }
  } else {
    chainBtn.disabled = false;
  }

  updateExportDurationHint();
  exportOverlay.classList.add('visible');
});

document.getElementById('btn-export-close').addEventListener('click', () => {
  if (!exportBusy) exportOverlay.classList.remove('visible');
});

// Mode toggle (pattern / chain)
document.getElementById('export-mode').addEventListener('click', (e) => {
  const btn = e.target.closest('.export-toggle-btn');
  if (!btn || btn.disabled) return;
  exportMode = btn.dataset.value;
  document.querySelectorAll('.export-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === exportMode);
  });
  updateExportDurationHint();
});

// Loops +/−
document.querySelectorAll('.export-loop-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const delta = parseInt(btn.dataset.delta);
    exportLoops = Math.max(1, Math.min(32, exportLoops + delta));
    document.getElementById('export-loops-val').textContent = exportLoops;
    updateExportDurationHint();
  });
});

// Tail +/−
document.querySelectorAll('.export-tail-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const delta = parseFloat(btn.dataset.delta);
    exportTail = Math.max(0, Math.min(10, exportTail + delta));
    document.getElementById('export-tail-val').textContent = exportTail.toFixed(1) + 's';
    updateExportDurationHint();
  });
});

// RENDER & DOWNLOAD
exportGoBtn.addEventListener('click', async () => {
  if (exportBusy) return;
  exportBusy = true;
  exportGoBtn.disabled = true;
  exportGoBtn.textContent = 'RENDERING…';
  exportProgressWrap.classList.add('visible');
  exportProgressFill.style.width = '0%';
  exportProgressText.textContent = 'SCHEDULING…';

  updateLCD('EXPORTING WAV…');

  try {
    const audioBuffer = await engine.renderOffline({
      mode: exportMode,
      loops: exportLoops,
      tail: exportTail,
      onProgress: (pct) => {
        const p = Math.round(pct * 100);
        exportProgressFill.style.width = p + '%';
        exportProgressText.textContent = `RENDERING ${p}%`;
      }
    });

    exportProgressText.textContent = 'ENCODING WAV…';
    exportProgressFill.style.width = '100%';

    const wavBlob = engine.encodeWav(audioBuffer);

    // Build filename
    const patName = PATTERN_NAMES[engine.activePatternIndex];
    const bpm = engine.tempo;
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[:-]/g, '');
    let filename;
    if (exportMode === 'chain') {
      const chainStr = engine.chain.map(i => PATTERN_NAMES[i]).join('');
      filename = `TR909_chain-${chainStr}_${bpm}bpm_${timestamp}.wav`;
    } else {
      filename = `TR909_pat-${patName}_${bpm}bpm_${timestamp}.wav`;
    }

    // Trigger download
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Calculate file size for display
    const sizeMB = (wavBlob.size / (1024 * 1024)).toFixed(1);
    exportProgressText.textContent = `DONE — ${sizeMB} MB`;
    exportGoBtn.textContent = 'RENDER & DOWNLOAD';
    exportGoBtn.disabled = false;
    updateLCD(`EXPORTED: ${filename} (${sizeMB} MB)`);
  } catch (err) {
    console.error('[909] Export error:', err);
    exportProgressText.textContent = 'ERROR!';
    exportGoBtn.textContent = 'RENDER & DOWNLOAD';
    exportGoBtn.disabled = false;
    updateLCD('EXPORT FAILED');
  }

  exportBusy = false;
});

// ─── Pattern Bank UI ─────────────────────────────────────────

const bankSlots = document.getElementById('bank-slots');
const bankStatus = document.getElementById('bank-status');

function refreshBankButtons() {
  const btns = bankSlots.querySelectorAll('.bank-btn');
  btns.forEach(btn => {
    const idx = +btn.dataset.index;
    btn.classList.toggle('active', idx === engine.activePatternIndex);
    btn.classList.toggle('queued', idx === engine.pendingPatternIndex);
    btn.classList.toggle('has-data', !engine.isPatternEmpty(idx));
    btn.classList.remove('chain-playing');
  });

  // In chain mode, highlight the currently playing chain pattern
  if (engine.chainMode && engine.isPlaying && engine.chain.length > 0) {
    const playingIdx = engine.chain[engine.chainPosition];
    const playingBtn = bankSlots.querySelector(`.bank-btn[data-index="${playingIdx}"]`);
    if (playingBtn) playingBtn.classList.add('chain-playing');
  }

  // Update status text
  if (engine.chainMode && engine.chain.length > 0) {
    bankStatus.textContent = `CHAIN ${engine.chainPosition + 1}/${engine.chain.length}`;
    bankStatus.classList.add('chain-active');
  } else {
    bankStatus.textContent = `PAT ${PATTERN_NAMES[engine.activePatternIndex]}`;
    if (engine.pendingPatternIndex >= 0) {
      bankStatus.textContent += ` → ${PATTERN_NAMES[engine.pendingPatternIndex]}`;
    }
    bankStatus.classList.remove('chain-active');
  }
}

// Click a bank slot: switch pattern (quantized if playing)
bankSlots.addEventListener('click', (e) => {
  const btn = e.target.closest('.bank-btn');
  if (!btn) return;
  const idx = +btn.dataset.index;

  if (engine.isPlaying) {
    // Queue the switch — it'll happen at end of bar
    engine.pendingPatternIndex = idx;
    updateLCD(`QUEUED: PAT ${PATTERN_NAMES[idx]}`);
  } else {
    engine.loadFromBank(idx);
    refreshGrid();
    updateLCD(`PAT ${PATTERN_NAMES[idx]}`);
  }
  refreshBankButtons();
});

// Engine callback: pattern actually changed
engine.onPatternChange = (patternIndex) => {
  refreshGrid();
  refreshBankButtons();
};

engine.onChainStep = (chainPos, patternIndex) => {
  refreshChainSequence();
  refreshBankButtons();
};

// Copy / Paste
document.getElementById('btn-copy').addEventListener('click', () => {
  engine.copyPattern();
  updateLCD(`COPIED PAT ${PATTERN_NAMES[engine.activePatternIndex]}`);
});

document.getElementById('btn-paste').addEventListener('click', () => {
  if (engine.pastePattern()) {
    refreshGrid();
    refreshBankButtons();
    updateLCD(`PASTED → PAT ${PATTERN_NAMES[engine.activePatternIndex]}`);
  } else {
    updateLCD('CLIPBOARD EMPTY');
  }
});

// ─── Chain Mode Toggle ───────────────────────────────────────

const chainToggleBtn = document.getElementById('btn-chain-toggle');

chainToggleBtn.addEventListener('click', () => {
  engine.chainMode = !engine.chainMode;
  chainToggleBtn.textContent = engine.chainMode ? 'ON' : 'OFF';
  chainToggleBtn.classList.toggle('active', engine.chainMode);

  if (engine.chainMode && engine.chain.length === 0) {
    updateLCD('CHAIN EMPTY — ADD PATTERNS');
  } else if (engine.chainMode) {
    updateLCD(`CHAIN: ${engine.chain.length} PATTERNS`);
  } else {
    updateLCD(`PAT ${PATTERN_NAMES[engine.activePatternIndex]}`);
  }
  refreshBankButtons();
});

// ─── Chain Editor ────────────────────────────────────────────

const chainOverlay = document.getElementById('chain-overlay');
const chainSequenceEl = document.getElementById('chain-sequence');

document.getElementById('btn-chain-edit').addEventListener('click', () => {
  refreshChainEditor();
  chainOverlay.classList.add('visible');
});

document.getElementById('btn-chain-close').addEventListener('click', () => {
  chainOverlay.classList.remove('visible');
});

document.getElementById('btn-chain-clear').addEventListener('click', () => {
  engine.clearChain();
  refreshChainEditor();
  refreshBankButtons();
  updateLCD('CHAIN CLEARED');
});

// Add pattern buttons in chain editor
document.getElementById('chain-add-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.chain-add-btn');
  if (!btn) return;
  const idx = +btn.dataset.index;
  engine.addToChain(idx);
  refreshChainEditor();
  refreshBankButtons();
});

function refreshChainEditor() {
  // Mark add buttons that reference empty patterns
  document.querySelectorAll('.chain-add-btn').forEach(btn => {
    const idx = +btn.dataset.index;
    btn.classList.toggle('empty-pattern', engine.isPatternEmpty(idx));
  });

  // Build sequence display
  chainSequenceEl.innerHTML = '';

  if (engine.chain.length === 0) {
    chainSequenceEl.innerHTML = '<div class="chain-empty">— empty — click pattern buttons above to add</div>';
    return;
  }

  engine.chain.forEach((patIdx, pos) => {
    if (pos > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'chain-arrow';
      arrow.textContent = '→';
      chainSequenceEl.appendChild(arrow);
    }

    const step = document.createElement('div');
    step.className = 'chain-step';
    if (engine.chainMode && engine.isPlaying && pos === engine.chainPosition) {
      step.classList.add('playing');
    }

    const btn = document.createElement('button');
    btn.className = 'chain-step-btn';
    btn.textContent = PATTERN_NAMES[patIdx];
    btn.title = `Click to remove`;
    btn.addEventListener('click', () => {
      engine.removeFromChain(pos);
      refreshChainEditor();
      refreshBankButtons();
    });

    step.appendChild(btn);
    chainSequenceEl.appendChild(step);
  });
}

function refreshChainSequence() {
  // Quick refresh just for playing highlight
  const steps = chainSequenceEl.querySelectorAll('.chain-step');
  steps.forEach((step, i) => {
    step.classList.toggle('playing', engine.chainMode && engine.isPlaying && i === engine.chainPosition);
  });
}

// ─── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  buildGrid();

  // Setup master knobs
  ['knob-tempo','knob-swing','knob-volume','knob-rev-decay','knob-rev-wet','knob-dly-time','knob-dly-fb','knob-dly-wet'].forEach(id => {
    const el = document.getElementById(id);
    if (el) setupKnob(el);
  });

  setupWaveEditorInteraction();
  updateLCD('TR-909 v2  |  PRESS SPACE');
  refreshBankButtons();
  refreshWaveEditor();
  initMIDI();
});
