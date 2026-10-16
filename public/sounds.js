(() => {
  let context;
  const Audio = window.AudioContext || window.webkitAudioContext;
  const denied = new Set(['not_yet_valid', 'expired', 'cannot_verify', 'malformed', 'unsupported', 'not_found']);

  function unlock() {
    const el = document.querySelector('#sound-enabled');
    if (!Audio || (el && !el.checked)) return;
    try {
      context ||= new Audio();
      if (context.state !== 'running') context.resume().catch(() => {});
    } catch { /* Sound is optional; the verification result remains visible. */ }
  }

  function tone(frequency, start, duration, waveform, volume) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.015);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }

  function play(result) {
    const el = document.querySelector('#sound-enabled');
    if (!context || context.state !== 'running' || (el && !el.checked)) return;
    const start = context.currentTime + 0.01;
    try {
      if (result === 'valid' || result === 'present') {
        tone(740, start, 0.12, 'sine', 0.15);
        tone(990, start + 0.14, 0.17, 'sine', 0.15);
      } else if (result === 'already_present') {
        tone(587, start, 0.10, 'sine', 0.12);
        tone(587, start + 0.15, 0.15, 'sine', 0.12);
      } else if (denied.has(result)) {
        tone(360, start, 0.18, 'triangle', 0.18);
        tone(260, start + 0.20, 0.26, 'triangle', 0.18);
      }
    } catch { /* Audio cannot affect the displayed verification decision. */ }
  }

  window.BadgeSounds = { unlock, play };
})();
