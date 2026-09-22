import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { patchAndroidManifest, patchResourcesArsc } from './manifestPatcher.js';
import { applyIconsToZip } from './iconPatcher.js';

const META_PREFIX = 'META-INF/';

/** Расширения, которые считаем «старым вебом» шаблона и вычищаем из assets/ */
const CLEAR_WEB_EXTS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'xml', 'txt', 'svg',
  'map', 'wasm', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot'
]);

/** Всё это кладём STORE (без пересжатия) */
const BINARY_EXTS = new Set([
  // android
  'dex', 'so', 'arsc',
  // images
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'heic', 'heif',
  // audio
  'mp3', 'ogg', 'wav', 'aac', 'm4a', 'flac', 'opus', 'wma', 'aiff', 'weba',
  // video
  'mp4', 'webm', 'mkv', 'mov', 'avi', 'ogv', '3gp',
  // 3d / game
  'glb', 'gltf', 'bin', 'obj', 'fbx', 'dae', 'stl', 'ply', '3ds', 'blend',
  'babylon', 'hdr', 'exr', 'ktx', 'ktx2', 'basis', 'dds', 'tga', 'psd',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // other binary
  'zip', 'gz', 'wasm', 'data', 'mem', 'unity3d', 'assetbundle', 'pak', 'bundle',
  'db', 'sqlite', 'bin', 'dat', 'raw', 'bytes'
]);

function extOf(path) {
  const name = path.split('/').pop() || '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function isBinaryPath(path) {
  const ext = extOf(path);
  if (BINARY_EXTS.has(ext) || path.includes('/lib/') || path.endsWith('.arsc')) return true;
  // текст — deflate, всё остальное неизвестное — STORE (безопаснее для медиа/моделей)
  const text = new Set(['html','htm','css','js','mjs','json','xml','txt','svg','map','vtt','csv','md','glsl','vert','frag','shader']);
  if (!ext) return true;
  return !text.has(ext);
}

/** Старые веб-файлы шаблона в assets/ — удаляем перед инъекцией */
function isOldTemplateWebPath(path) {
  if (!path.startsWith('assets/')) return false;
  if (path === 'assets/websitetoapk-meta.json') return true;

  const lower = path.toLowerCase();
  const ext = extOf(lower);

  if (CLEAR_WEB_EXTS.has(ext)) return true;
  if (lower.startsWith('assets/www/')) return true;
  if (lower.startsWith('assets/public/')) return true;
  if (lower.startsWith('assets/html/')) return true;
  if (lower.startsWith('assets/web/')) return true;
  if (lower.startsWith('assets/dist/')) return true;
  if (lower.startsWith('assets/app/')) return true;
  if (lower === 'assets/index.html' || lower === 'assets/index.htm') return true;

  return false;
}

function shouldSkipFromTemplate(path) {
  if (path.startsWith(META_PREFIX) || path === 'META-INF') return true;
  if (isOldTemplateWebPath(path)) return true;
  return false;
}

export async function loadZip(fileOrArrayBuffer) {
  return JSZip.loadAsync(fileOrArrayBuffer);
}

/**
 * Все файлы из ZIP (включая медиа, 3D, звуки, картинки).
 * Никакого фильтра по расширениям.
 */
export async function extractWebFiles(zip) {
  const files = {};
  const promises = [];

  zip.forEach((relativePath, file) => {
    if (file.dir) return;
    // пропускаем мусор macOS/windows
    const lower = relativePath.toLowerCase();
    if (lower.startsWith('__macosx/') || lower.includes('/.ds_store') || lower.endsWith('/.ds_store')) {
      return;
    }
    if (lower.endsWith('/thumbs.db') || lower.endsWith('thumbs.db')) return;

    promises.push(
      file.async('uint8array').then(content => {
        files[relativePath] = content;
      })
    );
  });

  await Promise.all(promises);
  return files;
}

export async function validateTemplate(zip) {
  const names = Object.keys(zip.files);
  const required = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc'];
  const missing = required.filter(r => !names.some(n => n === r || n.endsWith('/' + r)));

  if (missing.length) {
    throw new Error('Не удалось начать сборку. Попробуйте обновить страницу.');
  }

  const hasAssets = names.some(p => p.startsWith('assets/'));
  if (!hasAssets) {
    throw new Error('Не удалось начать сборку. Попробуйте обновить страницу.');
  }

  return true;
}

/** Нормализация пути: только слэши, без вырезания папок проекта. */
function normalizeRelPath(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}


/**
 * Если в ZIP один корневой каталог (my-site/index.html, my-site/img/...) —
 * убираем этот корень, чтобы index.html оказался в assets/index.html.
 */
function stripSingleRootFolder(filesMap) {
  const keys = Object.keys(filesMap);
  if (keys.length === 0) return filesMap;

  const tops = new Set();
  for (const k of keys) {
    const norm = k.replace(/\\/g, '/').replace(/^\/+/, '');
    const top = norm.split('/')[0];
    if (top) tops.add(top);
  }

  if (tops.size !== 1) return filesMap;
  const root = [...tops][0];
  // не схлопывать, если корень — уже осмысленная папка контента без вложенности index
  const hasNested = keys.some(k => k.replace(/\\/g, '/').includes('/'));
  if (!hasNested) return filesMap;

  const out = {};
  for (const [k, v] of Object.entries(filesMap)) {
    const norm = k.replace(/\\/g, '/').replace(/^\/+/, '');
    if (norm === root) continue;
    if (norm.startsWith(root + '/')) {
      out[norm.slice(root.length + 1)] = v;
    } else {
      out[norm] = v;
    }
  }
  return out;
}

function promoteIndex(filesMap) {
  let map = stripSingleRootFolder(filesMap);
  const keys = Object.keys(map);
  if (keys.length === 0) return map;

  const hasRootIndex = keys.some(k => {
    const n = normalizeRelPath(k).toLowerCase();
    return n === 'index.html' || n === 'index.htm';
  });
  if (hasRootIndex) return map;

  const nested = keys.find(k => {
    const n = normalizeRelPath(k).toLowerCase();
    return n.endsWith('/index.html') || n.endsWith('/index.htm');
  });

  if (!nested) return map;

  const out = { ...map };
  const content = out[nested];
  delete out[nested];
  out['index.html'] = content;
  return out;
}

function categorize(path) {
  const ext = extOf(path);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'ogg', 'wav', 'aac', 'm4a', 'flac', 'opus', 'weba'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mkv', 'mov', 'ogv', '3gp'].includes(ext)) return 'video';
  if (['glb', 'gltf', 'bin', 'obj', 'fbx', 'dae', 'stl', 'ply', 'hdr', 'ktx', 'ktx2', 'basis'].includes(ext)) return '3d';
  if (['html', 'htm', 'css', 'js', 'mjs', 'json', 'xml', 'txt'].includes(ext)) return 'web';
  return 'other';
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {Record<number, Uint8Array>|null} options.iconVariants
 */
export async function injectIntoTemplate(templateZip, webFiles, options = {}) {
  const config = options.config || options;
  const iconVariants = options.iconVariants || null;

  const output = new JSZip();
  const cleared = [];
  const injected = [];
  let manifestReport = null;
  let iconsReplaced = [];

  for (const path of Object.keys(templateZip.files)) {
    const entry = templateZip.files[path];
    if (entry.dir) continue;

    if (shouldSkipFromTemplate(path)) {
      cleared.push(path);
      continue;
    }

    let content = await entry.async('uint8array');

    if (
      path === 'AndroidManifest.xml' ||
      path.endsWith('/AndroidManifest.xml') ||
      path.toLowerCase().endsWith('androidmanifest.xml')
    ) {
      const patched = patchAndroidManifest(content, {
        packageName: config.packageName,
        versionName: config.versionName,
        versionCode: config.versionCode,
        appName: config.appName,
        orientation: config.orientation
      });
      content = patched.bytes;
      manifestReport = patched.report;
    }

    if (
      (path === 'resources.arsc' || path.endsWith('/resources.arsc') || path.toLowerCase().endsWith('resources.arsc')) &&
      config.appName
    ) {
      const arsc = patchResourcesArsc(content, config.appName);
      content = arsc.bytes;
      if (arsc.changed && manifestReport) {
        manifestReport.details.push(...arsc.details);
        if (!manifestReport.label) manifestReport.label = true;
      }
    }

    const useStore = entry._data?.compressionMethod === 0 || isBinaryPath(path);

    output.file(path, content, {
      binary: true,
      compression: useStore ? 'STORE' : 'DEFLATE',
      compressionOptions: useStore ? undefined : { level: 6 }
    });
  }

  if (!manifestReport) {
    manifestReport = {
      package: false,
      versionName: false,
      versionCode: false,
      label: false,
      details: ['AndroidManifest.xml не найден в APK'],
      poolStringsSample: []
    };
  }

  if (iconVariants) {
    iconsReplaced = applyIconsToZip(output, iconVariants);
  }

  const normalized = promoteIndex(webFiles);
  const stats = { image: 0, audio: 0, video: 0, '3d': 0, web: 0, other: 0, totalBytes: 0 };

  for (const [relPath, content] of Object.entries(normalized)) {
    const clean = normalizeRelPath(relPath);
    if (!clean || clean.endsWith('/')) continue;

    // не тащим служебное
    const lower = clean.toLowerCase();
    if (lower.startsWith('__macosx/') || lower.endsWith('.ds_store') || lower.endsWith('thumbs.db')) {
      continue;
    }

    const outPath = `assets/${clean}`;
    const useStore = isBinaryPath(outPath);
    const data = content instanceof Uint8Array ? content : new Uint8Array(content);

    output.file(outPath, data, {
      binary: true,
      compression: useStore ? 'STORE' : 'DEFLATE',
      compressionOptions: useStore ? undefined : { level: 6 }
    });
    injected.push(outPath);

    const cat = categorize(outPath);
    stats[cat] = (stats[cat] || 0) + 1;
    stats.totalBytes += data.byteLength;
  }

  const hasIndex = injected.some(p => {
    const n = p.toLowerCase();
    return n === 'assets/index.html' || n === 'assets/index.htm';
  });

  if (!hasIndex) {
    const fallback = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.appName || 'App'}</title></head><body style="margin:0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff;text-align:center"><div><h1>${config.appName || 'App'}</h1><p>index.html не найден</p></div></body></html>`;
    output.file('assets/index.html', fallback, { compression: 'DEFLATE' });
    injected.push('assets/index.html');
  }

  const meta = {
    appName: config.appName,
    packageName: config.packageName,
    versionName: config.versionName,
    versionCode: config.versionCode,
    generatedAt: new Date().toISOString(),
    generator: 'WebSiteToAPK',
    target: 'assets/',
    clearedCount: cleared.length,
    injected,
    injectStats: stats,
    iconsReplaced,
    manifestReport
  };
  output.file('assets/websitetoapk-meta.json', JSON.stringify(meta, null, 2), { compression: 'DEFLATE' });

  return { zip: output, cleared, injected, iconsReplaced, manifestReport, injectStats: stats };
}

export async function generateApkBlob(zip) {
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: 'application/vnd.android.package-archive',
    platform: 'UNIX'
  });
}
