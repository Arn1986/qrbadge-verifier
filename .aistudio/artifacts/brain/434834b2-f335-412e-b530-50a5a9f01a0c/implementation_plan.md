# QR Code Camera Overlay & Audio Feedback Restoration Plan

Restore real-time audio scan feedback across modern mobile/desktop browsers and re-introduce a camera overlay canvas that draws a bounding outline with glowing corner brackets around detected QR badges.

> [!IMPORTANT]
> **Confirmed User Decisions**:
> 1. **Camera QR Overlay**: Highlighting bounding outline with glowing corner brackets directly tracking the detected QR badge corners in real time.
> 2. **Audio Feedback**: Distinct synthesized tones for success (rising dual chime), duplicate (double mid-tone alert), and error (low buzz).

---

## 1. Overview & Core Concept

When event supervisors point their mobile camera at an attendee badge, they require immediate tactile and visual confirmation that:
1. The badge was recognized at its exact geometric location in the camera feed.
2. The verification status (valid check-in, duplicate scan, or unregistered identifier) is instantly audible even in busy, noisy venue environments.

This plan re-establishes the Web Audio engine with reliable browser interaction unlock handlers and mounts a dedicated viewport overlay canvas that tracks `jsQR` corner coordinates with glowing brackets.

```
┌────────────────────────────────────────────────────────┐
│ Scanner Viewport (.scanner)                            │
│                                                        │
│   ┌──────────────────────────────────────────────┐     │
│   │ <video id="video"> (camera stream)           │     │
│   └──────────────────────────────────────────────┘     │
│                         ▲                              │
│   ┌─────────────────────┴────────────────────────┐     │
│   │ <canvas id="qr-overlay"> (overlay layer)     │     │
│   │   ┌──┐                                ┌──┐   │     │
│   │   │  └────────────────────────────────┘  │   │     │
│   │   │   [QR BADGE BOUNDING POLYGON]        │   │     │
│   │   │  ┌────────────────────────────────┐  │   │     │
│   │   └──┘                                └──┘   │     │
│   │   Glowing Corner Brackets (#10b981)          │     │
│   └──────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────┘
```

---

## 2. Technical Architecture & Component Flow

```
Camera Frame Captured (requestAnimationFrame)
                │
                ▼
        jsQR Decoding Run
                │
         ┌──────┴──────┐
         │             │
    QR Detected   No QR in Frame
         │             │
         │             ▼
         │      Draw Viewfinder Reticle (Corner Guides)
         ▼
Scale Coordinates (Video Native -> Display Aspect Ratio)
         │
         ├──► 1. Draw Glowing Polygon on #qr-overlay
         ├──► 2. Draw 4 Corner Brackets (Thickened Vertices)
         ├──► 3. Trigger Audio Chime (BadgeSounds.play)
         └──► 4. Open Confirmation Modal / Send Verification API
```

---

## 3. Implementation Steps

### Phase A: Audio Feedback Engine Hardening (`public/sounds.js` & `public/app.js`)
- **Autoplay & AudioContext Policy Fix**:
  - Modern iOS Safari and Chrome strictly suspend `AudioContext` until initiated via a user gesture.
  - Bind global interaction unlock listeners (`pointerdown`, `click`, `touchstart`) to wake and resume `AudioContext`.
  - In `BadgeSounds.play(result)`: If `context` is suspended or uninitialized, automatically call `context.resume()` prior to scheduling tone oscillators instead of silently discarding audio.
- **Synthesized Distinct Tones**:
  - **Success / Valid (`valid`)**: 740 Hz $\rightarrow$ 990 Hz rising dual-tone chime with clean exponential decay.
  - **Duplicate (`already_present`)**: Double 587 Hz pulse with distinct spacing.
  - **Error / Unregistered (`not_found`, `denied`)**: 360 Hz $\rightarrow$ 260 Hz descending triangle wave buzz.
- **Audio Toggle Respect**: Respect the `#sound-enabled` checkbox state in real time.

### Phase B: Real-Time Camera QR Overlay (`public/index.html`, `public/style.css`, `public/app.js`)
- **Overlay Canvas Element**:
  - Add `<canvas id="qr-overlay" class="qr-overlay"></canvas>` directly inside `.scanner` positioned over `<video>`.
  - Style with `pointer-events: none; position: absolute; inset: 0; width: 100%; height: 100%;`.
- **Coordinate Transformation**:
  - Calculate video scale and letterbox offsets: compare `video.videoWidth` / `video.videoHeight` with `canvas.clientWidth` / `canvas.clientHeight` (handling `object-fit: contain`).
  - Map `qrCode.location` corners (`topLeftCorner`, `topRightCorner`, `bottomRightCorner`, `bottomLeftCorner`) to display canvas pixel space.
- **Visual Styling (Bounding Outline & Glowing Corner Brackets)**:
  - Connect corners with a smooth translucent glowing stroke (`rgba(16, 185, 129, 0.65)`, 2.5px width).
  - Draw accentuated L-shaped corner brackets at all 4 corners using `#10b981` (emerald green) with `shadowBlur: 10`, `shadowColor: '#10b981'`.
  - Idle state: Render stylish viewfinder corner targeting marks in `#7dd3c6` (brand teal) to guide operators on where to aim badges.
- **Overlay Reset**:
  - Clear the overlay when camera stops, when the modal confirms, or when the scan completes.

---

## 4. Verification & Testing Checklist
- [ ] Verify AudioContext resumes and plays audio on mobile and desktop upon scanning.
- [ ] Verify distinct tones for: new check-in (success), already present (duplicate), and unregistered barcode (error).
- [ ] Verify overlay canvas aligns with the QR badge corners across aspect ratios.
- [ ] Verify viewfinder guides appear when camera is active and clear when camera is stopped.
- [ ] Ensure `compile_applet` and `lint_applet` pass.
- [ ] Ensure `bun.lock` is not created.
