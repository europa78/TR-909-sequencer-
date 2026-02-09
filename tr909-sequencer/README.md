# TR-909 Rhythm Composer

A faithful recreation of the Roland TR-909 drum machine as a standalone Windows desktop app, built with Electron + Web Audio API.

![TR-909](https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Roland_TR-909_%28large%29.jpg/1280px-Roland_TR-909_%28large%29.jpg)

## Features

- **16-step sequencer** with per-instrument pattern editing
- **11 instruments**: Bass Drum, Snare, Low/Mid/Hi Tom, Rim Shot, Hand Clap, Closed/Open HH, Crash, Ride
- **Synthesized fallback sounds** — works out of the box, no samples needed
- **Load your own samples** — individual WAV/MP3 or entire kit folders with auto-mapping
- **Per-step velocity** — off / normal / accent (click cycles through)
- **Swing/Shuffle** — authentic 909-style swing on even 16th notes
- **Per-instrument controls** — Level, Mute, Solo
- **Preset patterns** — Classic 909, House, Breakbeat, Techno
- **Save/Load patterns** — .909 JSON format
- **Rock-solid timing** — Web Audio API scheduler with lookahead (no drift)
- **Keyboard shortcut** — Spacebar for play/stop

## Quick Start

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build Windows executable
npm run build
```

## Project Structure

```
tr909-sequencer/
├── main.js                  # Electron main process
├── preload.js               # IPC bridge (context isolation)
├── package.json
├── src/
│   ├── index.html           # Main UI
│   ├── css/
│   │   └── style.css        # 909-authentic styling
│   └── js/
│       ├── sequencer-engine.js  # Core audio engine & scheduler
│       └── app.js               # UI logic & interactions
└── samples/                 # (optional) your .wav/.mp3 sample kits
```

## Architecture

### Sequencer Engine (`sequencer-engine.js`)
The heart of the app. Uses the **"Two Clocks" pattern** for sample-accurate timing:
1. A `setTimeout` loop fires every 25ms (lookahead)
2. It schedules notes 100ms ahead using `audioContext.currentTime`
3. Samples are triggered via `AudioBufferSourceNode` at precise times

This decouples audio timing from the UI thread, preventing any tempo drift.

### Audio Chain (per voice)
```
AudioBufferSourceNode (sample + tuning)
  → GainNode (velocity + decay envelope)
    → StereoPannerNode (pan)
      → DynamicsCompressorNode (master bus)
        → GainNode (master volume)
          → destination
```

### Swing Implementation
Swing offsets even-numbered 16th notes by a variable amount:
- Swing 0 = perfectly straight
- Swing 50 = heavy shuffle (approaching triplet feel)
- Swing 80 = extreme drag

## Loading Samples

### Kit Folder (recommended)
Click **SAMPLES** → **LOAD KIT FOLDER** and select a folder containing your WAV/MP3 files. The app auto-maps files to instruments by matching keywords in filenames:

| Instrument | Keywords matched |
|------------|-----------------|
| Bass Drum  | kick, bass, bd |
| Snare      | snare, sd, snr |
| Closed HH  | closed, chh, ch |
| Open HH    | open, ohh, oh |
| etc.       | ... |

### Individual Samples
Click **SAMPLES**, then click any instrument slot to load a single file.

## Extending

### Adding more instruments
In `sequencer-engine.js`, add to the `_createDefaultInstruments()` array and update the `instrumentOrder` in `app.js`.

### Adding effects (reverb, delay, distortion)
Create effect nodes in the engine's `init()` method and insert them into the audio chain. Example:

```js
// Reverb send
this.reverbGain = ctx.createGain();
this.reverbGain.gain.value = 0.3;
this.convolver = ctx.createConvolver();
// Load impulse response...
this.reverbGain.connect(this.convolver);
this.convolver.connect(this.masterGain);
```

### Pattern chaining
The engine supports `totalSteps` — change it to 32 or 64 for longer patterns, or implement a pattern chain array.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Stop |
| Click step | Off → On → Accent → Off |
| Right-click step | Clear step |
| Click instrument label | Preview sound |

## License

MIT
