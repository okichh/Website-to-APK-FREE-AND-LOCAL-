import { PackageSigner } from 'https://esm.sh/@chromeos/android-package-signer@0.1.3';

const STORAGE_KEY = 'websitetoapk-keystore-v1';
const PASSWORD = 'websitetoapk1';
const ALIAS = 'websitetoapk';

const DNAME = {
  commonName: 'WebSiteToAPK',
  organizationName: 'WebSiteToAPK',
  organizationUnit: 'Local',
  countryCode: 'RU'
};

let cachedKey = null;

function loadKeyFromStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveKeyToStorage(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {}
}

function clearAllOldKeys() {
  try {
    localStorage.removeItem('web2apk-js-keystore-v1');
    localStorage.removeItem('web2apk-js-keystore-v2');
    localStorage.removeItem('websitetoapk-keystore-v3');
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function ensureDataUrlKey(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  if (raw.includes('base64,')) return raw.trim();
  return 'data:application/x-pkcs12;base64,' + raw.replace(/[\r\n\s]/g, '');
}

function stripDataUrl(str) {
  if (!str || typeof str !== 'string') return '';
  const idx = str.indexOf('base64,');
  if (idx !== -1) return str.slice(idx + 7).replace(/[\r\n\s]/g, '');
  return str.replace(/[\r\n\s]/g, '');
}

function base64ToBlob(b64, mime) {
  const clean = stripDataUrl(b64);
  if (!clean) throw new Error('Не удалось завершить сборку');

  let binary;
  try {
    binary = atob(clean);
  } catch (e) {
    throw new Error('Не удалось завершить сборку');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function generateFreshKey() {
  const signer = new PackageSigner(PASSWORD, ALIAS);
  const raw = await signer.generateKey(DNAME);
  if (!raw) throw new Error('Не удалось завершить сборку');
  const key = ensureDataUrlKey(raw);
  cachedKey = key;
  saveKeyToStorage(key);
  return key;
}

export async function ensureKeystore() {
  if (cachedKey) return cachedKey;

  const stored = loadKeyFromStorage();
  if (stored && stored.includes('base64,')) {
    cachedKey = stored;
    return cachedKey;
  }

  return generateFreshKey();
}

export async function signApkBlob(unsignedBlob) {
  let key = await ensureKeystore();
  key = ensureDataUrlKey(key);

  const file = new File([unsignedBlob], 'app.apk', {
    type: 'application/vnd.android.package-archive'
  });

  const attempt = async (keyToUse) => {
    const signer = new PackageSigner(PASSWORD, ALIAS);
    return signer.signPackage(file, keyToUse, 'WebSiteToAPK');
  };

  let result;
  try {
    result = await attempt(key);
  } catch (e) {
    const msg = (e?.message || String(e)).toLowerCase();

    if (
      msg.includes('mac could not be verified') ||
      msg.includes('invalid password') ||
      msg.includes('pkcs#12') ||
      msg.includes('pkcs12')
    ) {
      clearAllOldKeys();
      cachedKey = null;
      key = await generateFreshKey();
      result = await attempt(key);
    } else {
      throw new Error('Не удалось завершить сборку');
    }
  }

  if (!result || typeof result !== 'string') {
    throw new Error('Не удалось завершить сборку');
  }

  return base64ToBlob(result, 'application/vnd.android.package-archive');
}

export function clearStoredKey() {
  cachedKey = null;
  clearAllOldKeys();
}
