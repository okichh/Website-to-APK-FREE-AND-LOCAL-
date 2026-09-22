import { WebsiteToApkBuilder } from './modules/converter.js';
import { pickFile, pickFolder } from './modules/filePicker.js';
import {
  $,
  showScreen,
  setStepProgress,
  consoleClear,
  consoleWrite,
  setBuildProgress,
  enable
} from './modules/ui.js';

const builder = new WebsiteToApkBuilder();
const TOTAL_STEPS = 3;
let siteReady = false;

function readOptionsFromForm() {
  const orientEl = document.querySelector('input[name="opt-orientation"]:checked');
  builder.setAppOptions({
    appName: $('#opt-name').value,
    versionName: $('#opt-version').value,
    versionCode: $('#opt-build').value,
    packageName: $('#opt-package').value,
    orientation: orientEl ? orientEl.value : 'portrait'
  });
}

function fillSummary() {
  readOptionsFromForm();
  const o = builder.appOptions;
  $('#sum-name').textContent = o.appName;
  $('#sum-version').textContent = o.versionName;
  $('#sum-build').textContent = String(o.versionCode);
  $('#sum-package').textContent = o.packageName;
  const orientMap = { portrait: 'Портретный', landscape: 'Альбомный', auto: 'Авто' };
  $('#sum-orientation').textContent = orientMap[o.orientation] || o.orientation || '—';

  const img = $('#summary-icon');
  const ph = $('#summary-icon-placeholder');
  if (builder.iconPreviewUrl) {
    img.src = builder.iconPreviewUrl;
    img.hidden = false;
    ph.hidden = true;
  } else {
    img.hidden = true;
    ph.hidden = false;
  }
}

function goStep(n) {
  document.querySelectorAll('[data-step]').forEach(el => {
    el.hidden = Number(el.dataset.step) !== n;
  });
  setStepProgress(n, TOTAL_STEPS);
  if (n === 3) fillSummary();
}

function updateBuildButton() {
  enable('#btn-build', siteReady);
}

$('#btn-start').addEventListener('click', () => {
  showScreen('wizard');
  goStep(1);
});

$('#btn-step1-next').addEventListener('click', () => {
  readOptionsFromForm();
  const o = builder.appOptions;
  if (!o.appName.trim()) {
    alert('Укажите название приложения');
    return;
  }
  if (!o.packageName.includes('.')) {
    alert('Package Name укажите в формате com.example.app');
    return;
  }
  goStep(2);
});

$('#btn-step2-back').addEventListener('click', () => goStep(1));

$('#btn-pick-icon').addEventListener('click', async () => {
  try {
    const file = await pickFile('.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp');
    const { width, height } = await builder.setIcon(file);
    $('#icon-file-label').textContent = file.name;
    $('#icon-preview-wrap').hidden = false;
    $('#icon-preview').src = builder.iconPreviewUrl;
    $('#icon-size-label').textContent = `${width}×${height}`;
    enable('#btn-step2-next', true);
  } catch (e) {
    if (e.message !== 'Cancelled') alert(e.message || String(e));
  }
});

$('#btn-step2-next').addEventListener('click', () => {
  if (!builder.iconVariants) {
    alert('Выберите иконку');
    return;
  }
  goStep(3);
});

$('#btn-step3-back').addEventListener('click', () => goStep(2));

async function loadSite(kind) {
  try {
    let count = 0;
    if (kind === 'folder') {
      const files = await pickFolder();
      count = await builder.loadSiteFromFolder(files);
    } else {
      const file = await pickFile('.zip,application/zip');
      count = await builder.loadSiteFromZip(file);
    }
    siteReady = count > 0;
    $('#site-status').textContent = siteReady ? `Загружено файлов: ${count}` : 'Источник не выбран';
    updateBuildButton();
  } catch (e) {
    if (e.message !== 'Cancelled') alert(e.message || String(e));
  }
}

$('#btn-site-folder').addEventListener('click', () => {
  $('#url-panel').hidden = true;
  loadSite('folder');
});
$('#btn-site-zip').addEventListener('click', () => {
  $('#url-panel').hidden = true;
  loadSite('zip');
});
$('#btn-site-url').addEventListener('click', () => {
  $('#url-panel').hidden = false;
  $('#opt-url').focus();
});
$('#btn-url-apply').addEventListener('click', () => {
  try {
    const url = $('#opt-url').value;
    builder.loadSiteFromUrl(url);
    siteReady = true;
    $('#site-status').textContent = 'URL: ' + builder.sourceUrl;
    updateBuildButton();
  } catch (e) {
    alert(e.message || String(e));
  }
});

$('#btn-build').addEventListener('click', async () => {
  readOptionsFromForm();
  showScreen('build');
  consoleClear();
  setBuildProgress(0, 'Старт');
  enable('#btn-download', false);
  $('#btn-download').hidden = true;
  $('#btn-again').hidden = true;

  consoleWrite('Сборка запущена', 'info');

  try {
    await builder.build();
    $('#btn-download').hidden = false;
    enable('#btn-download', true);
    $('#btn-again').hidden = false;
    consoleWrite('Можно скачать приложение', 'success');
  } catch (e) {
    consoleWrite(e.message || 'Не удалось завершить сборку', 'error');
    $('#btn-again').hidden = false;
  }
});

$('#btn-download').addEventListener('click', () => {
  try {
    builder.download();
  } catch (e) {
    consoleWrite(e.message || 'Ошибка скачивания', 'error');
  }
});

$('#btn-again').addEventListener('click', () => {
  siteReady = false;
  builder.siteFiles = null;
  builder.sourceMode = null;
  builder.sourceUrl = null;
  builder.signedBlob = null;
  $('#url-panel').hidden = true;
  $('#site-status').textContent = 'Источник не указан';
  updateBuildButton();
  showScreen('wizard');
  goStep(3);
  fillSummary();
});

showScreen('welcome');
