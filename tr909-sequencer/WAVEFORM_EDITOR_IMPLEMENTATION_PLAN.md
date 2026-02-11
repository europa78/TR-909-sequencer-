# Waveform Editor Implementation Plan

## Goal
Add a **single, shared waveform editor** to the sequencer UI. The editor will sit on the **right side** of the sequencer, show the waveform for the **currently selected track/instrument** (BD, SD, CHH, etc.), and provide:
- Adjustable **start marker**
- Adjustable **end marker**
- Auto-detected **hit points**
- A user-adjustable **threshold** parameter that controls hit-point detection sensitivity

## Implementation Steps

1. **Add editor panel markup to the layout**
   - Introduce a new main content split container for:
     - Left: existing step labels + instrument grid
     - Right: waveform editor panel
   - Add a large waveform editor canvas with marker controls and hit-point threshold control.

2. **Track selected instrument state**
   - Add a `selectedInstrumentId` state variable in `app.js`.
   - When clicking an instrument label or waveform thumbnail, mark that instrument as selected.
   - Show visual selected-row styling in the grid.

3. **Store per-instrument waveform edit settings**
   - Add a structure to hold `start`, `end`, `threshold`, and detected `hitPoints` per instrument.
   - Initialize defaults for all instruments (`start=0`, `end=1`, sensible default threshold).

4. **Build waveform editor rendering logic**
   - Draw the selected instrument waveform in the larger canvas.
   - Draw start/end markers as vertical draggable guides.
   - Draw hit points as vertical indicator lines based on threshold.
   - Ensure the canvas is visually large enough for peak/trough editing.

5. **Implement marker interaction**
   - Add pointer/mouse dragging for start/end markers with bounds:
     - `start < end`
     - Both stay within `[0, 1]`
   - Keep markers responsive and easy to grab.

6. **Implement threshold-based hit-point detection**
   - Detect hit points by scanning waveform amplitude within the start/end region and collecting local onset candidates above threshold.
   - Recompute hit points whenever threshold, sample buffer, or start/end values change.

7. **Wire playback to start/end markers**
   - Update sample triggering in `sequencer-engine.js` to respect per-instrument trim:
     - Start playback at marker start offset
     - Stop playback at marker end offset
   - Keep existing sequencing behavior intact.

8. **Persist editor state in save/load session flow**
   - Include waveform edit settings in session save payload.
   - Restore settings on session load and refresh UI/editor rendering.

9. **Styling updates**
   - Add CSS for right-side editor panel, controls, markers, and selected row highlight.
   - Preserve existing TR-909 look while ensuring readability and editability.

10. **Validation**
    - Confirm instrument selection switches editor waveform correctly.
    - Confirm marker dragging updates playback range.
    - Confirm threshold changes hit-point density.
    - Confirm layout places editor on right and remains usable.
