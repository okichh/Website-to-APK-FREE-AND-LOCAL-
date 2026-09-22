export const APP_BRAND = 'WebSiteToAPK';
export const APP_TAGLINE = 'бесплатный и локальный конвертер веб-сайтов в .apk';

export const DEFAULT_APP_OPTIONS = {
  appName: 'My App',
  packageName: 'com.example.app',
  versionName: '1.0.0',
  versionCode: 1,
  orientation: 'portrait' // portrait | landscape | auto
};

/** Android screenOrientation enum (typed int in AXML) */
export const ORIENTATION_ANDROID = {
  portrait: 1,
  landscape: 0,
  auto: 10 // fullSensor
};

export const ORIENTATION_LABELS = {
  portrait: 'Портретный',
  landscape: 'Альбомный',
  auto: 'Авто'
};

/** JSON, встраиваемый в APK (assets/websitetoapk-meta.json) */
export function buildApkMeta(options, extra = {}) {
  return {
    generator: 'WebSiteToAPK',
    appName: options.appName,
    packageName: options.packageName,
    versionName: options.versionName,
    versionCode: options.versionCode,
    orientation: options.orientation || 'portrait',
    generatedAt: new Date().toISOString(),
    ...extra
  };
}

export function sanitizePackageName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100) || 'com.example.app';
}

export function sanitizeAppName(name) {
  return (name || 'App').trim().slice(0, 50);
}

/** Шаблон рядом со статикой: public/template/template.zip */
export const TEMPLATE_CANDIDATES = [
  './template/template.zip',
  './template/template.apk',
  '../template/template.zip',
  '../template/template.apk'
];
