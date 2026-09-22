import {
  DEFAULT_APP_OPTIONS,
  sanitizePackageName,
  sanitizeAppName,
  TEMPLATE_CANDIDATES,
  buildApkMeta
} from './config.js';
import { loadZip, injectIntoTemplate, generateApkBlob, validateTemplate } from './zipHandler.js';
import { folderToFilesMap, zipToFilesMap, readFileAsArrayBuffer } from './filePicker.js';
import { consoleWrite, setBuildProgress, downloadBlob } from './ui.js';
import { ensureKeystore, signApkBlob } from './signer.js';
import { prepareIconVariants } from './iconPatcher.js';

export class WebsiteToApkBuilder {
  constructor() {
    this.templateZip = null;
    this.siteFiles = null;
    this.sourceMode = null; // 'files' | 'url'
    this.sourceUrl = null;
    this.iconVariants = null;
    this.iconPreviewUrl = null;
    this.iconFileName = null;
    this.appOptions = { ...DEFAULT_APP_OPTIONS };
    this.signedBlob = null;
  }

  setAppOptions(partial) {
    this.appOptions = {
      ...this.appOptions,
      ...partial,
      appName: sanitizeAppName(partial.appName ?? this.appOptions.appName),
      packageName: sanitizePackageName(partial.packageName ?? this.appOptions.packageName),
      versionName: String(partial.versionName ?? this.appOptions.versionName).trim() || '1.0.0',
      versionCode: parseInt(partial.versionCode ?? this.appOptions.versionCode, 10) || 1,
      orientation: ['portrait', 'landscape', 'auto'].includes(partial.orientation)
        ? partial.orientation
        : (this.appOptions.orientation || 'portrait')
    };
  }

  async loadBundledTemplate() {
    for (const url of TEMPLATE_CANDIDATES) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength < 1000) continue;
        const zip = await loadZip(buffer);
        await validateTemplate(zip);
        this.templateZip = zip;
        return true;
      } catch {
        /* try next candidate */
      }
    }
    throw new Error('Не удалось начать сборку. Попробуйте позже или обновите страницу.');
  }

  async loadSiteFromFolder(fileList) {
    this.siteFiles = await folderToFilesMap(fileList);
    this.sourceMode = 'files';
    this.sourceUrl = null;
    return Object.keys(this.siteFiles).length;
  }

  async loadSiteFromZip(file) {
    const buffer = await readFileAsArrayBuffer(file);
    this.siteFiles = await zipToFilesMap(buffer);
    this.sourceMode = 'files';
    this.sourceUrl = null;
    return Object.keys(this.siteFiles).length;
  }

  /**
   * Режим URL: в APK кладётся index.html, который открывает адрес.
   */
  loadSiteFromUrl(url) {
    let u = String(url || '').trim();
    if (!u) throw new Error('Введите адрес сайта');
    if (!/^https?:\/\//i.test(u)) {
      u = 'https://' + u;
    }
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Нужен адрес http:// или https://');
      }
      u = parsed.href;
    } catch (e) {
      if (e.message && e.message.includes('http')) throw e;
      throw new Error('Некорректный адрес');
    }

    const safe = u.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const jsSafe = u.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c');
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>App</title>
  <style>
    html,body{margin:0;height:100%;background:#111;color:#eee;font-family:system-ui,sans-serif}
    .boot{display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center}
  </style>
  <script>
    location.replace('${jsSafe}');
  </script>
</head>
<body>
  <div class="boot">Открытие сайта…</div>
  <noscript><p class="boot"><a href="${safe}">Открыть сайт</a></p></noscript>
</body>
</html>
`;
    const enc = new TextEncoder();
    this.siteFiles = {
      'index.html': enc.encode(html)
    };
    this.sourceMode = 'url';
    this.sourceUrl = u;
    return 1;
  }


  async setIcon(file) {
    const { variants, width, height } = await prepareIconVariants(file);
    this.iconVariants = variants;
    this.iconFileName = file.name;
    if (this.iconPreviewUrl) URL.revokeObjectURL(this.iconPreviewUrl);
    this.iconPreviewUrl = URL.createObjectURL(file);
    return { width, height };
  }

  async build() {
    this.signedBlob = null;

    if (!this.siteFiles || !Object.keys(this.siteFiles).length) {
      throw new Error('Сначала загрузите файлы сайта.');
    }

    setBuildProgress(8, 'Подготовка');
    consoleWrite('Подготовка…', 'info');

    if (!this.templateZip) {
      await this.loadBundledTemplate();
    }

    setBuildProgress(20, 'Параметры');
    consoleWrite('Применение параметров приложения…', 'info');

    setBuildProgress(35, 'Упаковка');
    consoleWrite('Упаковка сайта…', 'info');
    await ensureKeystore();

    const { zip: outZip, injected, injectStats } = await injectIntoTemplate(
      this.templateZip,
      this.siteFiles,
      {
        config: this.appOptions,
        iconVariants: this.iconVariants
      }
    );

    if (this.sourceMode === 'url') {
      consoleWrite('Режим: открытие URL', 'info');
      consoleWrite(this.sourceUrl, 'success');
    } else {
      consoleWrite(`Добавлено файлов: ${injected.length}`, 'success');
    }
    if (injectStats) {
      const parts = [];
      if (injectStats.image) parts.push(`изображений ${injectStats.image}`);
      if (injectStats.audio) parts.push(`аудио ${injectStats.audio}`);
      if (injectStats['3d']) parts.push(`3D ${injectStats['3d']}`);
      if (injectStats.web) parts.push(`страниц и скриптов ${injectStats.web}`);
      if (parts.length) consoleWrite(parts.join(', '), 'info');
    }

    setBuildProgress(55, 'Сборка');
    consoleWrite('Сборка APK…', 'info');
    const unsignedBlob = await generateApkBlob(outZip);

    setBuildProgress(75, 'Завершение');
    consoleWrite('Завершение…', 'info');
    const signedBlob = await signApkBlob(unsignedBlob);

    setBuildProgress(100, 'Готово');
    consoleWrite(`Готово · ${(signedBlob.size / 1024).toFixed(0)} KB`, 'success');
    this.signedBlob = signedBlob;
    return signedBlob;
  }

  download() {
    if (!this.signedBlob) throw new Error('Сборка ещё не завершена.');
    const safe = this.appOptions.appName.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_') || 'app';
    const name = `${safe}_${this.appOptions.versionName}.apk`;
    downloadBlob(this.signedBlob, name);
    consoleWrite('Скачивание началось', 'success');
  }
  }
