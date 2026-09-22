/**
 * Иконка приложения → mipmap/drawable ic_launcher*.png
 * Только png/jpg/jpeg/webp, сторона — степень двойки, ≤ 1024.
 */

const SIZES = [
  { folder: 'mipmap-mdpi', size: 48 },
  { folder: 'mipmap-hdpi', size: 72 },
  { folder: 'mipmap-xhdpi', size: 96 },
  { folder: 'mipmap-xxhdpi', size: 144 },
  { folder: 'mipmap-xxxhdpi', size: 192 },
  { folder: 'drawable-mdpi', size: 48 },
  { folder: 'drawable-hdpi', size: 72 },
  { folder: 'drawable-xhdpi', size: 96 },
  { folder: 'drawable-xxhdpi', size: 144 },
  { folder: 'drawable-xxxhdpi', size: 192 },
  { folder: 'drawable-ldpi-v4', size: 36 },
  { folder: 'drawable-mdpi-v4', size: 48 },
  { folder: 'drawable-hdpi-v4', size: 72 },
  { folder: 'drawable-xhdpi-v4', size: 96 },
  { folder: 'drawable-xxhdpi-v4', size: 144 },
  { folder: 'drawable', size: 192 },
  { folder: 'mipmap', size: 192 }
];

const ICON_NAME_RE = /ic_launcher|app_icon|^icon\.png$/i;

export const ALLOWED_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const ALLOWED_ICON_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

export function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

export function validateIconFile(file) {
  const name = (file.name || '').toLowerCase();
  const okExt = ALLOWED_ICON_EXT.some(ext => name.endsWith(ext));
  const okType = !file.type || ALLOWED_ICON_TYPES.includes(file.type) || file.type === 'image/jpg';
  if (!okExt && !okType) {
    return { ok: false, error: 'Допустимы только PNG, JPG, JPEG и WEBP.' };
  }
  return { ok: true };
}

export function validateIconDimensions(width, height) {
  if (width !== height) {
    return { ok: false, error: `Иконка должна быть квадратной (сейчас ${width}×${height}).` };
  }
  if (width > 1024) {
    return { ok: false, error: 'Максимальный размер — 1024×1024.' };
  }
  if (!isPowerOfTwo(width)) {
    return { ok: false, error: `Сторона должна быть степенью двойки (32, 64, 128, 256, 512, 1024). Сейчас ${width}.` };
  }
  return { ok: true };
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

function resizeToPngBytes(img, size) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    canvas.toBlob(blob => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.readAsArrayBuffer(blob);
    }, 'image/png');
  });
}

export async function prepareIconVariants(file) {
  const check = validateIconFile(file);
  if (!check.ok) throw new Error(check.error);

  const img = await loadImageFromFile(file);
  const dim = validateIconDimensions(img.naturalWidth, img.naturalHeight);
  if (!dim.ok) throw new Error(dim.error);

  const variants = {};
  const unique = [...new Map(SIZES.map(s => [s.size, s])).values()];
  for (const { size } of unique) {
    variants[size] = await resizeToPngBytes(img, size);
  }
  return { variants, width: img.naturalWidth, height: img.naturalHeight };
}

function pickSizeForPath(path) {
  const lower = path.toLowerCase();
  for (const { folder, size } of SIZES) {
    if (lower.includes('/' + folder + '/') || lower.includes('/' + folder)) return size;
  }
  return 192;
}

function isLauncherIconPath(path) {
  if (!path.startsWith('res/')) return false;
  if (!path.toLowerCase().endsWith('.png')) return false;
  const name = path.split('/').pop() || '';
  return ICON_NAME_RE.test(name);
}

export function applyIconsToZip(zip, variants) {
  const replaced = [];
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (entry.dir || !isLauncherIconPath(path)) continue;
    const size = pickSizeForPath(path);
    const data = variants[size] || variants[192];
    if (!data) continue;
    zip.file(path, data, { binary: true, compression: 'STORE' });
    replaced.push(path);
  }
  if (!replaced.length && variants[192]) {
    const fallback = 'res/mipmap-xxxhdpi/ic_launcher.png';
    zip.file(fallback, variants[192], { binary: true, compression: 'STORE' });
    replaced.push(fallback);
  }
  return replaced;
}
