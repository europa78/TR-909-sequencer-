/**
 * TR-909 Sequencer Engine v2
 * 
 * Features:
 *  - Two-clocks scheduling (Web Audio + setTimeout lookahead)
 *  - Per-instrument: level, tune, decay, pan, filter (LP cutoff + resonance)
 *  - Master send effects: reverb (convolver) and delay (with feedback)
 *  - Per-instrument send levels for reverb and delay
 */

class SequencerEngine {
  constructor() {
    this.audioContext = null;
    this.isPlaying = false;
    this.tempo = 120;
    this.swing = 0;
    this.currentStep = 0;
    this.totalSteps = 16;
    this.masterVolume = 0.8;

    // Scheduling
    this.LOOKAHEAD = 25.0;
    this.SCHEDULE_AHEAD = 0.1;
    this.nextNoteTime = 0.0;
    this.schedulerTimerID = null;

    // Master bus nodes
    this.masterGain = null;
    this.compressor = null;

    // Send effects
    this.reverbNode = null;
    this.reverbGain = null;
    this.reverbWet = 0.5;
    this.reverbDecay = 2.0;

    this.delayNode = null;
    this.delayFeedback = null;
    this.delayGain = null;
    this.delayFilter = null;
    this.delayTime = 0.375;
    this.delayFeedbackAmount = 0.35;
    this.delayWet = 0.4;

    // Instruments
    this.instruments = this._createDefaultInstruments();

    // ── Pattern Bank (8 slots: A-H) ──
    this.patternBank = [];        // Array of 8 pattern snapshots
    this.activePatternIndex = 0;  // Which pattern is being edited/viewed
    this.pendingPatternIndex = -1;// Queued pattern (switches at end of bar)

    // ── Chain Mode ──
    this.chainMode = false;       // false = single pattern loop, true = chain playback
    this.chain = [];              // Array of pattern indices, e.g. [0,0,1,0,2,3]
    this.chainPosition = 0;       // Current position within the chain
    this.chainRepeat = true;      // Loop the chain

    // Initialize 8 empty pattern slots
    for (let i = 0; i < 8; i++) {
      this.patternBank.push(this._createEmptyPatternSnapshot());
    }

    // Clipboard for copy/paste
    this._clipboard = null;

    // Callbacks
    this.onStepChange = null;
    this.onStop = null;
    this.onPatternChange = null;  // (patternIndex) => {} — fires when pattern actually switches
    this.onChainStep = null;      // (chainPosition, patternIndex) => {}
  }

  // ─── Initialization ─────────────────────────────────────────

  async init() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 44100
    });

    const ctx = this.audioContext;

    // Master chain: compressor → gain → destination
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -6;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.1;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.masterVolume;

    this.compressor.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // ── Reverb send bus ──
    this.reverbNode = ctx.createConvolver();
    this.reverbNode.buffer = this._generateReverbIR(this.reverbDecay);

    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = this.reverbWet;

    this.reverbNode.connect(this.reverbGain);
    this.reverbGain.connect(this.compressor);

    // ── Delay send bus ──
    this.delayNode = ctx.createDelay(5.0);
    this.delayNode.delayTime.value = this.delayTime;

    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = this.delayFeedbackAmount;

    this.delayGain = ctx.createGain();
    this.delayGain.gain.value = this.delayWet;

    // Darken repeats like analog delay
    this.delayFilter = ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 3500;
    this.delayFilter.Q.value = 0.5;

    // Delay routing: delayNode → filter → [delayGain → compressor] + [feedback → delayNode]
    this.delayNode.connect(this.delayFilter);
    this.delayFilter.connect(this.delayGain);
    this.delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayGain.connect(this.compressor);

    console.log('[909] Engine v2 initialized with reverb + delay sends');
    return this;
  }

  // ─── Generate Reverb Impulse Response ───────────────────────

  _generateReverbIR(decayTime) {
    return this._generateReverbIRForContext(this.audioContext, decayTime);
  }

  // ─── Default Instruments ────────────────────────────────────

  _createDefaultInstruments() {
    const defs = [
      { id: 'bd',    name: 'Bass Drum',   shortName: 'BD',  color: '#e84030' },
      { id: 'sd',    name: 'Snare Drum',  shortName: 'SD',  color: '#e8a030' },
      { id: 'lt',    name: 'Low Tom',     shortName: 'LT',  color: '#e8d830' },
      { id: 'mt',    name: 'Mid Tom',     shortName: 'MT',  color: '#e8d830' },
      { id: 'ht',    name: 'Hi Tom',      shortName: 'HT',  color: '#e8d830' },
      { id: 'rim',   name: 'Rim Shot',    shortName: 'RM',  color: '#e84030' },
      { id: 'clap',  name: 'Hand Clap',   shortName: 'CP',  color: '#e8a030' },
      { id: 'chh',   name: 'Closed HH',   shortName: 'CH',  color: '#50b8e8' },
      { id: 'ohh',   name: 'Open HH',     shortName: 'OH',  color: '#50b8e8' },
      { id: 'crash', name: 'Crash',       shortName: 'CR',  color: '#50b8e8' },
      { id: 'ride',  name: 'Ride',        shortName: 'RD',  color: '#50b8e8' },
    ];

    const instruments = {};
    for (const def of defs) {
      instruments[def.id] = {
        ...def,
        buffer: null,
        pattern: new Array(16).fill(0),
        level: 0.8,
        tune: 0,              // -12 to +12 semitones
        decay: 1.0,           // 0.1 to 2.0
        pan: 0,
        filterCutoff: 20000,  // 100 - 20000 Hz
        filterRes: 0,         // 0 - 25
        reverbSend: 0,        // 0-1
        delaySend: 0,         // 0-1
        muted: false,
        soloed: false,
      };
    }
    return instruments;
  }

  // ─── Sample Loading ─────────────────────────────────────────

  async loadSample(instrumentId, arrayBuffer) {
    if (!this.audioContext) await this.init();
    try {
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
      this.instruments[instrumentId].buffer = audioBuffer;
      return true;
    } catch (err) {
      console.error(`[909] Failed to decode sample for ${instrumentId}:`, err);
      return false;
    }
  }

  // ─── Transport ──────────────────────────────────────────────

  start() {
    if (this.isPlaying || !this.audioContext) return;
    if (this.audioContext.state === 'suspended') this.audioContext.resume();
    this.isPlaying = true;
    this.currentStep = 0;
    this.pendingPatternIndex = -1;
    this.nextNoteTime = this.audioContext.currentTime;

    // If chain mode, load the first pattern in the chain
    if (this.chainMode && this.chain.length > 0) {
      this.chainPosition = 0;
      this.loadFromBank(this.chain[0]);
      if (this.onChainStep) this.onChainStep(0, this.chain[0]);
      if (this.onPatternChange) this.onPatternChange(this.chain[0]);
    }

    this._scheduler();
  }

  stop() {
    this.isPlaying = false;
    if (this.schedulerTimerID) { clearTimeout(this.schedulerTimerID); this.schedulerTimerID = null; }
    this.currentStep = 0;
    this.pendingPatternIndex = -1;
    if (this.chainMode) this.chainPosition = 0;
    if (this.onStop) this.onStop();
  }

  // ─── Core Scheduler ────────────────────────────────────────

  _scheduler() {
    if (!this.isPlaying) return;
    while (this.nextNoteTime < this.audioContext.currentTime + this.SCHEDULE_AHEAD) {
      this._scheduleStep(this.currentStep, this.nextNoteTime);
      this._advanceStep();
    }
    this.schedulerTimerID = setTimeout(() => this._scheduler(), this.LOOKAHEAD);
  }

  _advanceStep() {
    const sPB = 60.0 / this.tempo;
    const sP16 = sPB / 4;
    if (this.currentStep % 2 === 1 && this.swing > 0) {
      this.nextNoteTime += sP16 + (this.swing / 100) * sP16;
    } else if (this.currentStep % 2 === 0 && this.swing > 0) {
      this.nextNoteTime += sP16 - (this.swing / 100) * sP16;
    } else {
      this.nextNoteTime += sP16;
    }

    this.currentStep = (this.currentStep + 1) % this.totalSteps;

    // ── End of bar: handle pattern switching ──
    if (this.currentStep === 0) {
      this._handleEndOfBar();
    }
  }

  _handleEndOfBar() {
    // Priority 1: Pending manual pattern queue
    if (this.pendingPatternIndex >= 0) {
      this.loadFromBank(this.pendingPatternIndex);
      this.pendingPatternIndex = -1;
      if (this.onPatternChange) this.onPatternChange(this.activePatternIndex);
      return;
    }

    // Priority 2: Chain mode advancement
    if (this.chainMode && this.chain.length > 0) {
      this.chainPosition = (this.chainPosition + 1);

      if (this.chainPosition >= this.chain.length) {
        if (this.chainRepeat) {
          this.chainPosition = 0;
        } else {
          // Chain finished — stop or stay on last
          this.chainMode = false;
          return;
        }
      }

      const nextPatIdx = this.chain[this.chainPosition];
      this.loadFromBank(nextPatIdx);

      if (this.onChainStep) this.onChainStep(this.chainPosition, nextPatIdx);
      if (this.onPatternChange) this.onPatternChange(nextPatIdx);
    }
  }

  _scheduleStep(step, time) {
    if (this.onStepChange) {
      const delay = Math.max(0, (time - this.audioContext.currentTime) * 1000);
      setTimeout(() => {
        if (!this.isPlaying) return;
        this.onStepChange(step);
      }, delay);
    }
    const hasSolo = Object.values(this.instruments).some(i => i.soloed);
    for (const [id, inst] of Object.entries(this.instruments)) {
      if (!inst.buffer || inst.muted) continue;
      if (hasSolo && !inst.soloed) continue;
      if (inst.pattern[step] === 0) continue;
      this._triggerSample(inst, time, inst.pattern[step]);
    }
  }

  // ─── Sample Triggering (with filter + sends) ───────────────

  _triggerSample(instrument, time, velocity) {
    const ctx = this.audioContext;

    const source = ctx.createBufferSource();
    source.buffer = instrument.buffer;
    source.playbackRate.value = Math.pow(2, instrument.tune / 12);

    // Gain envelope
    const gainNode = ctx.createGain();
    const baseGain = instrument.level * (velocity === 2 ? 1.2 : 0.85);
    gainNode.gain.setValueAtTime(baseGain, time);

    const duration = instrument.buffer.duration * instrument.decay;
    if (instrument.decay < 1.8) {
      gainNode.gain.setValueAtTime(baseGain, time + duration * 0.7);
      gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);
    }

    // Filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(instrument.filterCutoff, time);
    filter.Q.value = instrument.filterRes;

    // Pan
    const panner = ctx.createStereoPanner();
    panner.pan.value = instrument.pan;

    // Chain: source → gain → filter → panner
    source.connect(gainNode);
    gainNode.connect(filter);
    filter.connect(panner);

    // Dry path
    panner.connect(this.compressor);

    // Reverb send
    if (instrument.reverbSend > 0 && this.reverbNode) {
      const rs = ctx.createGain();
      rs.gain.value = instrument.reverbSend;
      panner.connect(rs);
      rs.connect(this.reverbNode);
    }

    // Delay send
    if (instrument.delaySend > 0 && this.delayNode) {
      const ds = ctx.createGain();
      ds.gain.value = instrument.delaySend;
      panner.connect(ds);
      ds.connect(this.delayNode);
    }

    source.start(time);
    if (instrument.decay < 1.8) source.stop(time + duration + 0.01);
  }

  // ─── Pattern Bank Management ─────────────────────────────────

  _createEmptyPatternSnapshot() {
    const snap = {};
    const instIds = ['bd','sd','lt','mt','ht','rim','clap','chh','ohh','crash','ride'];
    for (const id of instIds) {
      snap[id] = new Array(16).fill(0);
    }
    return snap;
  }

  /** Save current instrument patterns into bank slot */
  saveToBank(index) {
    if (index < 0 || index >= 8) return;
    const snap = {};
    for (const [id, inst] of Object.entries(this.instruments)) {
      snap[id] = [...inst.pattern];
    }
    this.patternBank[index] = snap;
  }

  /** Load patterns from bank slot into instruments (for editing/playback) */
  loadFromBank(index) {
    if (index < 0 || index >= 8) return;
    // Save current pattern to its slot before switching
    this.saveToBank(this.activePatternIndex);

    const snap = this.patternBank[index];
    for (const [id, pattern] of Object.entries(snap)) {
      if (this.instruments[id]) {
        this.instruments[id].pattern = [...pattern];
      }
    }
    this.activePatternIndex = index;
  }

  /** Queue a pattern to switch at the end of the current bar */
  queuePattern(index) {
    if (index < 0 || index >= 8) return;
    if (this.isPlaying) {
      this.pendingPatternIndex = index;
    } else {
      this.loadFromBank(index);
    }
  }

  /** Copy current pattern to clipboard */
  copyPattern() {
    const snap = {};
    for (const [id, inst] of Object.entries(this.instruments)) {
      snap[id] = [...inst.pattern];
    }
    this._clipboard = snap;
  }

  /** Paste clipboard into current pattern */
  pastePattern() {
    if (!this._clipboard) return false;
    for (const [id, pattern] of Object.entries(this._clipboard)) {
      if (this.instruments[id]) {
        this.instruments[id].pattern = [...pattern];
      }
    }
    this.saveToBank(this.activePatternIndex);
    return true;
  }

  /** Check if a bank slot has any active steps */
  isPatternEmpty(index) {
    const snap = this.patternBank[index];
    if (!snap) return true;
    for (const pattern of Object.values(snap)) {
      if (pattern.some(v => v > 0)) return false;
    }
    return true;
  }

  // ─── Chain Management ──────────────────────────────────────

  setChain(chainArray) {
    this.chain = [...chainArray];
    this.chainPosition = 0;
  }

  addToChain(patternIndex) {
    if (patternIndex < 0 || patternIndex >= 8) return;
    this.chain.push(patternIndex);
  }

  removeFromChain(position) {
    if (position < 0 || position >= this.chain.length) return;
    this.chain.splice(position, 1);
    if (this.chainPosition >= this.chain.length) {
      this.chainPosition = 0;
    }
  }

  clearChain() {
    this.chain = [];
    this.chainPosition = 0;
  }

  // ─── Pattern Manipulation ──────────────────────────────────

  toggleStep(instrumentId, step) {
    const inst = this.instruments[instrumentId];
    if (!inst) return;
    inst.pattern[step] = (inst.pattern[step] + 1) % 3;
    this.saveToBank(this.activePatternIndex);
    return inst.pattern[step];
  }

  setStep(instId, step, val) {
    if (this.instruments[instId]) {
      this.instruments[instId].pattern[step] = val;
      this.saveToBank(this.activePatternIndex);
    }
  }

  clearPattern(instrumentId) {
    if (instrumentId) { this.instruments[instrumentId].pattern.fill(0); }
    else { for (const inst of Object.values(this.instruments)) inst.pattern.fill(0); }
    this.saveToBank(this.activePatternIndex);
  }

  clearAllPatterns() {
    for (let i = 0; i < this.patternBank.length; i++) {
      this.patternBank[i] = this._createEmptyPatternSnapshot();
    }
    for (const inst of Object.values(this.instruments)) {
      inst.pattern.fill(0);
    }
    this.activePatternIndex = 0;
    this.pendingPatternIndex = -1;
    this.clearChain();
  }

  // ─── Parameter Setters ─────────────────────────────────────

  setTempo(bpm) { this.tempo = Math.max(30, Math.min(300, bpm)); }
  setSwing(a) { this.swing = Math.max(0, Math.min(100, a)); }

  setMasterVolume(val) {
    this.masterVolume = val;
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(val, this.audioContext.currentTime, 0.01);
  }

  setInstrumentParam(id, param, val) {
    if (this.instruments[id]) this.instruments[id][param] = val;
  }

  // ─── Send Effect Controls ──────────────────────────────────

  setReverbWet(v) { this.reverbWet = v; if (this.reverbGain) this.reverbGain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.02); }
  setReverbDecay(s) { this.reverbDecay = s; if (this.reverbNode && this.audioContext) this.reverbNode.buffer = this._generateReverbIR(s); }
  setDelayTime(s) { this.delayTime = s; if (this.delayNode) this.delayNode.delayTime.setTargetAtTime(s, this.audioContext.currentTime, 0.02); }
  setDelayFeedback(v) { this.delayFeedbackAmount = v; if (this.delayFeedback) this.delayFeedback.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.02); }
  setDelayWet(v) { this.delayWet = v; if (this.delayGain) this.delayGain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.02); }

  syncDelayToTempo(div) {
    const b = 60.0 / this.tempo;
    const m = { '1/4': b, '1/8': b/2, '1/8d': b*0.75, '1/16': b/4, '1/8t': b/3 };
    const t = m[div] || b/2;
    this.setDelayTime(t);
    return t;
  }

  // ─── Offline Rendering (WAV Export) ─────────────────────────

  /**
   * Render pattern(s) to an AudioBuffer using OfflineAudioContext.
   * @param {Object} opts
   * @param {'pattern'|'chain'} opts.mode - Render current pattern or full chain
   * @param {number} opts.loops - How many times to loop (pattern mode) or play chain
   * @param {number} opts.tail - Extra seconds for reverb/delay tail
   * @param {function} opts.onProgress - (0-1) progress callback
   * @returns {Promise<AudioBuffer>}
   */
  async renderOffline(opts = {}) {
    const mode = opts.mode || 'pattern';
    const loops = opts.loops || 1;
    const tail = opts.tail !== undefined ? opts.tail : 2.0;
    const onProgress = opts.onProgress || (() => {});

    // Calculate total duration
    const barDuration = (60.0 / this.tempo) * 4; // 4 beats per bar

    let totalBars;
    if (mode === 'chain' && this.chain.length > 0) {
      totalBars = this.chain.length * loops;
    } else {
      totalBars = loops;
    }

    const contentDuration = totalBars * barDuration;
    const totalDuration = contentDuration + tail;
    const sampleRate = 44100;

    // Create offline context
    const offCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);

    // ── Build the same audio routing as the live engine ──

    // Compressor → Master Gain → Destination
    const comp = offCtx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.1;

    const masterGain = offCtx.createGain();
    masterGain.gain.value = this.masterVolume;

    comp.connect(masterGain);
    masterGain.connect(offCtx.destination);

    // Reverb send
    const reverbConv = offCtx.createConvolver();
    reverbConv.buffer = this._generateReverbIRForContext(offCtx, this.reverbDecay);

    const reverbGain = offCtx.createGain();
    reverbGain.gain.value = this.reverbWet;

    reverbConv.connect(reverbGain);
    reverbGain.connect(comp);

    // Delay send
    const delayNode = offCtx.createDelay(5.0);
    delayNode.delayTime.value = this.delayTime;

    const delayFb = offCtx.createGain();
    delayFb.gain.value = this.delayFeedbackAmount;

    const delayWetGain = offCtx.createGain();
    delayWetGain.gain.value = this.delayWet;

    const delayLPF = offCtx.createBiquadFilter();
    delayLPF.type = 'lowpass';
    delayLPF.frequency.value = 3500;
    delayLPF.Q.value = 0.5;

    delayNode.connect(delayLPF);
    delayLPF.connect(delayWetGain);
    delayLPF.connect(delayFb);
    delayFb.connect(delayNode);
    delayWetGain.connect(comp);

    // ── Schedule all steps ──

    // Save current state
    const savedActive = this.activePatternIndex;
    this.saveToBank(savedActive);

    let time = 0;
    const sP16base = 60.0 / this.tempo / 4;

    const hasSolo = Object.values(this.instruments).some(i => i.soloed);

    for (let bar = 0; bar < totalBars; bar++) {
      // Determine which pattern to use for this bar
      let patternSnap;
      if (mode === 'chain' && this.chain.length > 0) {
        const chainIdx = bar % this.chain.length;
        patternSnap = this.patternBank[this.chain[chainIdx]];
      } else {
        patternSnap = this.patternBank[this.activePatternIndex];
      }

      // Schedule 16 steps
      for (let step = 0; step < 16; step++) {
        // Trigger each instrument
        for (const [id, inst] of Object.entries(this.instruments)) {
          if (!inst.buffer || inst.muted) continue;
          if (hasSolo && !inst.soloed) continue;

          const vel = patternSnap[id] ? patternSnap[id][step] : 0;
          if (vel === 0) continue;

          // Schedule the trigger
          this._renderTrigger(offCtx, inst, time, vel, comp, reverbConv, delayNode);
        }

        // Advance time (with swing)
        if (step % 2 === 1 && this.swing > 0) {
          time += sP16base + (this.swing / 100) * sP16base;
        } else if (step % 2 === 0 && this.swing > 0) {
          time += sP16base - (this.swing / 100) * sP16base;
        } else {
          time += sP16base;
        }
      }

      onProgress((bar + 1) / totalBars);
    }

    // Render
    const renderedBuffer = await offCtx.startRendering();

    // Restore state
    this.loadFromBank(savedActive);

    return renderedBuffer;
  }

  /** Trigger a sample into the offline context */
  _renderTrigger(ctx, instrument, time, velocity, compressor, reverbNode, delayNode) {
    const source = ctx.createBufferSource();
    source.buffer = instrument.buffer;
    source.playbackRate.value = Math.pow(2, instrument.tune / 12);

    const gainNode = ctx.createGain();
    const baseGain = instrument.level * (velocity === 2 ? 1.2 : 0.85);
    gainNode.gain.setValueAtTime(baseGain, time);

    const duration = instrument.buffer.duration * instrument.decay;
    if (instrument.decay < 1.8) {
      gainNode.gain.setValueAtTime(baseGain, time + duration * 0.7);
      gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);
    }

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(instrument.filterCutoff, time);
    filter.Q.value = instrument.filterRes;

    const panner = ctx.createStereoPanner();
    panner.pan.value = instrument.pan;

    source.connect(gainNode);
    gainNode.connect(filter);
    filter.connect(panner);

    // Dry
    panner.connect(compressor);

    // Reverb send
    if (instrument.reverbSend > 0 && reverbNode) {
      const rs = ctx.createGain();
      rs.gain.value = instrument.reverbSend;
      panner.connect(rs);
      rs.connect(reverbNode);
    }

    // Delay send
    if (instrument.delaySend > 0 && delayNode) {
      const ds = ctx.createGain();
      ds.gain.value = instrument.delaySend;
      panner.connect(ds);
      ds.connect(delayNode);
    }

    source.start(time);
    if (instrument.decay < 1.8) source.stop(time + duration + 0.01);
  }

  /** Generate reverb IR for a given context (offline or live) */
  _generateReverbIRForContext(ctx, decayTime) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * decayTime);
    const buffer = ctx.createBuffer(2, len, sr);

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const envelope = Math.exp(-t / (decayTime * 0.3));
        data[i] = (Math.random() * 2 - 1) * envelope;

        // Early reflections
        if (t < 0.08) {
          const earlyGain = 1.0 - (t / 0.08) * 0.5;
          data[i] *= earlyGain * 1.5;
        }
      }
    }

    return buffer;
  }

  /**
   * Encode an AudioBuffer as a WAV file and return as Blob.
   * @param {AudioBuffer} audioBuffer
   * @returns {Blob}
   */
  encodeWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitsPerSample = 16;

    // Interleave channels
    const length = audioBuffer.length;
    const buffer = new ArrayBuffer(44 + length * numChannels * (bitsPerSample / 8));
    const view = new DataView(buffer);

    // WAV header
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);                          // chunk size
    view.setUint16(20, format, true);                       // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, length * numChannels * (bitsPerSample / 8), true);

    // Get channel data
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    // Write interleaved samples
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i];
        // Clamp
        sample = Math.max(-1, Math.min(1, sample));
        // Convert to 16-bit
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // ─── Preset Patterns ───────────────────────────────────────

  loadPreset(name) {
    const presets = {
      'classic-909': { tempo:126, swing:0, patterns:{ bd:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], sd:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], chh:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], ohh:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0], clap:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0] }},
      'house': { tempo:124, swing:0, patterns:{ bd:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], chh:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0], ohh:[0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1], clap:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0] }},
      'breakbeat': { tempo:138, swing:20, patterns:{ bd:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], sd:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1], chh:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], ride:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0] }},
      'techno': { tempo:135, swing:0, patterns:{ bd:[1,0,0,1,0,0,1,0,1,0,0,1,0,0,1,0], sd:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], chh:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], clap:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,2], rim:[0,0,0,0,0,0,0,1,0,0,1,0,0,0,0,0] }},
      'dub-techno': { tempo:120, swing:10,
        patterns:{ bd:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], rim:[0,0,0,0,1,0,0,1,0,0,0,0,1,0,0,0], chh:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], ohh:[0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0], clap:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0] },
        sends:{ rim:{reverbSend:0.6,delaySend:0.3}, clap:{reverbSend:0.5,delaySend:0.2}, chh:{reverbSend:0.2,delaySend:0.4}, ohh:{reverbSend:0.4,delaySend:0.3} }
      }
    };
    const p = presets[name]; if (!p) return false;
    this.clearPattern(); this.setTempo(p.tempo); this.setSwing(p.swing);
    for (const inst of Object.values(this.instruments)) { inst.reverbSend = 0; inst.delaySend = 0; }
    for (const [id, pat] of Object.entries(p.patterns)) if (this.instruments[id]) this.instruments[id].pattern = [...pat];
    if (p.sends) for (const [id, s] of Object.entries(p.sends)) if (this.instruments[id]) Object.assign(this.instruments[id], s);
    this.saveToBank(this.activePatternIndex);
    return true;
  }

  // ─── Serialization ─────────────────────────────────────────

  serialize() {
    // Save current patterns into bank before serializing
    this.saveToBank(this.activePatternIndex);

    const data = {
      tempo: this.tempo, swing: this.swing, masterVolume: this.masterVolume,
      reverbWet: this.reverbWet, reverbDecay: this.reverbDecay,
      delayTime: this.delayTime, delayFeedbackAmount: this.delayFeedbackAmount, delayWet: this.delayWet,
      activePatternIndex: this.activePatternIndex,
      patternBank: this.patternBank.map(snap => {
        const s = {};
        for (const [id, pat] of Object.entries(snap)) s[id] = [...pat];
        return s;
      }),
      chain: [...this.chain],
      instruments: {}
    };
    for (const [id, inst] of Object.entries(this.instruments)) {
      data.instruments[id] = { pattern:[...inst.pattern], level:inst.level, tune:inst.tune, decay:inst.decay, pan:inst.pan, filterCutoff:inst.filterCutoff, filterRes:inst.filterRes, reverbSend:inst.reverbSend, delaySend:inst.delaySend, muted:inst.muted, soloed:inst.soloed };
    }
    return data;
  }

  deserialize(data) {
    if (data.tempo) this.setTempo(data.tempo);
    if (data.swing !== undefined) this.setSwing(data.swing);
    if (data.masterVolume !== undefined) this.setMasterVolume(data.masterVolume);
    if (data.reverbWet !== undefined) this.setReverbWet(data.reverbWet);
    if (data.reverbDecay !== undefined) this.setReverbDecay(data.reverbDecay);
    if (data.delayTime !== undefined) this.setDelayTime(data.delayTime);
    if (data.delayFeedbackAmount !== undefined) this.setDelayFeedback(data.delayFeedbackAmount);
    if (data.delayWet !== undefined) this.setDelayWet(data.delayWet);

    // Restore pattern bank
    if (data.patternBank && Array.isArray(data.patternBank)) {
      for (let i = 0; i < Math.min(data.patternBank.length, 8); i++) {
        const snap = {};
        for (const [id, pat] of Object.entries(data.patternBank[i])) {
          snap[id] = [...pat];
        }
        this.patternBank[i] = snap;
      }
    }

    // Restore chain
    if (data.chain) this.chain = [...data.chain];

    // Restore active pattern from the bank snapshot
    if (data.activePatternIndex !== undefined) {
      this.loadFromBank(data.activePatternIndex);
    }

    if (data.instruments) {
      for (const [id, params] of Object.entries(data.instruments)) {
        if (!this.instruments[id]) continue;
        for (const [k, v] of Object.entries(params)) {
          if (k === 'pattern') this.instruments[id].pattern = [...v];
          else if (v !== undefined) this.instruments[id][k] = v;
        }
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = SequencerEngine;
