(() => {
  let context = null;
  const Audio = window.AudioContext || window.webkitAudioContext;
  const denied = new Set(['not_yet_valid', 'expired', 'cannot_verify', 'malformed', 'unsupported', 'not_found']);

  function isSoundEnabled() {
    const el = document.querySelector?.('#sound-enabled');
    return !el || el.checked;
  }

  function getContext() {
    if (!Audio) return null;
    if (!context) {
      try {
        context = new Audio();
      } catch {
        return null;
      }
    }
    return context;
  }

  function unlock() {
    if (!isSoundEnabled()) return;
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
      try {
        ctx.resume().catch(() => {});
      } catch {
        // Fallback gracefully if browser policy delays resumption
      }
    }
  }

  // Register capture-phase unlock triggers on any user interaction if addEventListener is available
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const triggerUnlock = () => {
      unlock();
    };
    ['click', 'touchstart', 'pointerdown', 'keydown'].forEach(evt => {
      window.addEventListener(evt, triggerUnlock, { capture: true, passive: true });
    });
  }

  function tone(frequency, start, duration, waveform, volume) {
    if (!context || context.state !== 'running') return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
      oscillator.onended = () => {
        try {
          oscillator.disconnect();
          gain.disconnect();
        } catch {}
      };
    } catch {}
  }

  function play(result) {
    if (!isSoundEnabled()) return;
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
      try {
        ctx.resume().catch(() => {});
      } catch {}
    }
    if (ctx.state !== 'running') return;

    const start = ctx.currentTime + 0.01;
    try {
      if (result === 'valid' || result === 'present') {
        // Crisp, rising dual-tone chime (Success: 740Hz, 990Hz)
        tone(740, start, 0.11, 'sine', 0.18);
        tone(990, start + 0.13, 0.16, 'sine', 0.18);
      } else if (result === 'already_present') {
        // Distinct double beep (Already checked in: 587Hz, 587Hz)
        tone(587, start, 0.09, 'sine', 0.14);
        tone(587, start + 0.13, 0.12, 'sine', 0.14);
      } else if (denied.has(result)) {
        // Low descending double buzz (Error / Unregistered / Denied: 360Hz, 260Hz)
        tone(360, start, 0.15, 'triangle', 0.20);
        tone(260, start + 0.17, 0.22, 'triangle', 0.20);
      }
    } catch {
      // Audio failure must never crash or block visual verification flow
    }
  }

  window.BadgeSounds = { unlock, play };
})();
