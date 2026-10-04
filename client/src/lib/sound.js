// Web Audio chimes (no audio files needed) + Thai text-to-speech for queue calls.
let ctx;
function ac() { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); return ctx; }
export function unlockAudio() { try { ac(); } catch { /* ignore */ } }

function tone(freq, start, dur, type = 'sine', gain = 0.25) {
  const c = ac();
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.05);
}
export function playNewOrder() { try { tone(880, 0, 0.18, 'square', 0.15); tone(1175, 0.2, 0.18, 'square', 0.15); tone(1568, 0.4, 0.35, 'square', 0.15); } catch { /* ignore */ } }
export function playChime() { try { tone(659, 0, 0.5); tone(523, 0.45, 0.8); } catch { /* ignore */ } }
export function playBeep() { try { tone(1000, 0, 0.12, 'sine', 0.2); } catch { /* ignore */ } }
export function playError() { try { tone(220, 0, 0.25, 'sawtooth', 0.15); tone(180, 0.25, 0.35, 'sawtooth', 0.15); } catch { /* ignore */ } }

export function speak(text, lang = 'th-TH') {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang; u.rate = 0.9;
  const v = speechSynthesis.getVoices().find((x) => x.lang?.startsWith('th'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
