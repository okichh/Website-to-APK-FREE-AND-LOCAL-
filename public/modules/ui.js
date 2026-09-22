export function $(sel) {
  return document.querySelector(sel);
}

export function $all(sel) {
  return [...document.querySelectorAll(sel)];
}

export function showScreen(id) {
  $all('[data-screen]').forEach(el => {
    const on = el.dataset.screen === id;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  });
}

export function setStepProgress(stepIndex, totalSteps) {
  const step = Math.min(Math.max(1, stepIndex), totalSteps);
  const pct = Math.round((step / totalSteps) * 100);
  const bar = $('#global-progress-bar');
  const label = $('#global-progress-label');
  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = `Этап ${step} из ${totalSteps}`;
  document.querySelectorAll('[data-step-dot]').forEach(el => {
    const n = Number(el.dataset.stepDot);
    el.classList.toggle('is-active', n === step);
    el.classList.toggle('is-done', n < step);
  });
}

export function consoleClear() {
  const el = $('#build-console');
  if (el) el.innerHTML = '';
}

export function consoleWrite(msg, type = 'info') {
  const el = $('#build-console');
  if (!el) return;
  const line = document.createElement('div');
  line.className = 'console-line console-' + type;
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

export function setBuildProgress(pct, text) {
  const bar = $('#build-progress-bar');
  const label = $('#build-progress-text');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (label) label.textContent = text || '';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function enable(el, on) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.disabled = !on;
}
