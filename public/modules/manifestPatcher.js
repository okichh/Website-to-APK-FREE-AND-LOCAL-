/**
 * Полноценный патч AndroidManifest.xml:
 * пересборка string pool → любые длины package / versionName / label.
 */

function readU32(v, o) { return v.getUint32(o, true); }
function writeU32(v, o, x) { v.setUint32(o, x >>> 0, true); }
function readU16(v, o) { return v.getUint16(o, true); }
function writeU16(v, o, x) { v.setUint16(o, x, true); }

function looksPkg(s) {
  return typeof s === 'string' && /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(s) && s.includes('.');
}

function isVersionLike(s) {
  return typeof s === 'string' && (/^(\d+\.)+\d+/.test(s) || s === '1.0' || s === '0.1');
}

/* ───────── encode strings ───────── */

function encodeUtf8PoolString(str) {
  const data = new TextEncoder().encode(str);
  const charLen = str.length;
  const byteLen = data.length;
  const parts = [];

  if (charLen > 0x7f) {
    parts.push(0x80 | ((charLen >> 8) & 0x7f), charLen & 0xff);
  } else {
    parts.push(charLen & 0x7f);
  }
  if (byteLen > 0x7f) {
    parts.push(0x80 | ((byteLen >> 8) & 0x7f), byteLen & 0xff);
  } else {
    parts.push(byteLen & 0x7f);
  }
  const header = new Uint8Array(parts);
  const out = new Uint8Array(header.length + data.length + 1);
  out.set(header, 0);
  out.set(data, header.length);
  out[header.length + data.length] = 0;
  return out;
}

function encodeUtf16PoolString(str) {
  const charLen = str.length;
  const out = new Uint8Array(2 + charLen * 2 + 2);
  out[0] = charLen & 0xff;
  out[1] = (charLen >> 8) & 0xff;
  for (let i = 0; i < charLen; i++) {
    const c = str.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[2 + i * 2 + 1] = c >> 8;
  }
  return out;
}

/* ───────── parse pool ───────── */

function parsePool(bytes, poolOffset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = readU32(view, poolOffset);
  const chunkSize = readU32(view, poolOffset + 4);
  const stringCount = readU32(view, poolOffset + 8);
  const styleCount = readU32(view, poolOffset + 12);
  const flags = readU32(view, poolOffset + 16);
  const stringsStart = readU32(view, poolOffset + 20);
  const stylesStart = readU32(view, poolOffset + 24);
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const offsetsTable = poolOffset + 28;

  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const rel = readU32(view, offsetsTable + i * 4);
    const abs = poolOffset + stringsStart + rel;
    if (abs < 0 || abs >= bytes.length) {
      strings.push('');
      continue;
    }
    if (isUtf8) {
      let p = abs;
      let charLen = bytes[p++];
      if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | bytes[p++];
      let byteLen = bytes[p++];
      if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | bytes[p++];
      try {
        strings.push(new TextDecoder('utf-8').decode(bytes.subarray(p, p + byteLen)));
      } catch {
        let s = '';
        for (let j = 0; j < byteLen; j++) s += String.fromCharCode(bytes[p + j]);
        strings.push(s);
      }
    } else {
      let charLen = bytes[abs] | (bytes[abs + 1] << 8);
      let dataStart = abs + 2;
      if (charLen & 0x8000) {
        charLen = ((charLen & 0x7fff) << 16) | (bytes[abs + 2] | (bytes[abs + 3] << 8));
        dataStart = abs + 4;
      }
      let s = '';
      for (let j = 0; j < charLen; j++) {
        const c = bytes[dataStart + j * 2] | (bytes[dataStart + j * 2 + 1] << 8);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      strings.push(s);
    }
  }

  // style offsets + style data copy as raw for rebuild
  let stylesRaw = new Uint8Array(0);
  if (styleCount > 0 && stylesStart > 0) {
    const stylesAbs = poolOffset + stylesStart;
    const stylesLen = chunkSize - stylesStart;
    if (stylesLen > 0 && stylesAbs + stylesLen <= bytes.length) {
      stylesRaw = bytes.slice(stylesAbs, stylesAbs + stylesLen);
    }
  }

  return {
    type, chunkSize, stringCount, styleCount, flags, stringsStart, stylesStart,
    isUtf8, strings, stylesRaw, poolOffset
  };
}

/**
 * Пересобрать string pool chunk с новыми строками (любая длина).
 * Индексы строк сохраняются.
 */
function rebuildPoolChunk(pool) {
  const { strings, isUtf8, styleCount, flags, stylesRaw, type } = pool;
  const stringCount = strings.length;

  const encoded = strings.map(s =>
    isUtf8 ? encodeUtf8PoolString(s || '') : encodeUtf16PoolString(s || '')
  );

  // offsets relative to start of string data section
  // Align each string to 4 bytes (Android often aligns)
  const ALIGN = 4;
  const offsets = [];
  let dataLen = 0;
  const pieces = [];
  for (let i = 0; i < stringCount; i++) {
    offsets.push(dataLen);
    pieces.push(encoded[i]);
    dataLen += encoded[i].length;
    const pad = (ALIGN - (dataLen % ALIGN)) % ALIGN;
    if (pad) {
      pieces.push(new Uint8Array(pad));
      dataLen += pad;
    }
  }

  // header: 28 bytes + offsets (stringCount*4) + styleOffsets (styleCount*4) + data + styles
  const styleOffsetsSize = styleCount * 4;
  const offsetsSize = stringCount * 4;
  const stringsStart = 28 + offsetsSize + styleOffsetsSize;
  // align stringsStart to 4
  const stringsStartAligned = stringsStart + ((4 - (stringsStart % 4)) % 4);
  const padBeforeData = stringsStartAligned - stringsStart;

  let stylesStart = 0;
  let total = stringsStartAligned + dataLen;
  if (styleCount > 0 && stylesRaw.length) {
    stylesStart = total;
    total += stylesRaw.length;
  }
  // align chunk size to 4
  const chunkSize = total + ((4 - (total % 4)) % 4);

  const out = new Uint8Array(chunkSize);
  const view = new DataView(out.buffer);

  // type: keep 0x001C0001 for AXML
  writeU32(view, 0, type || 0x001c0001);
  writeU32(view, 4, chunkSize);
  writeU32(view, 8, stringCount);
  writeU32(view, 12, styleCount);
  writeU32(view, 16, flags);
  writeU32(view, 20, stringsStartAligned);
  writeU32(view, 24, stylesStart);

  let o = 28;
  for (let i = 0; i < stringCount; i++) {
    writeU32(view, o, offsets[i]);
    o += 4;
  }
  // style offsets — zero if we don't parse them; keep original style data at end
  for (let i = 0; i < styleCount; i++) {
    writeU32(view, o, 0);
    o += 4;
  }
  // pad before data
  o = stringsStartAligned;
  for (const p of pieces) {
    out.set(p, o);
    o += p.length;
  }
  if (stylesStart && stylesRaw.length) {
    out.set(stylesRaw, stylesStart);
  }

  return out;
}

function findAxmlPool(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, 0) !== 0x00080003) {
    throw new Error('Не AXML (magic)');
  }
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = readU32(view, offset);
    const size = readU32(view, offset + 4);
    if (size < 8 || offset + size > bytes.length) break;
    if (type === 0x001c0001) {
      return { offset, size, pool: parsePool(bytes, offset) };
    }
    offset += size;
  }
  throw new Error('String pool не найден');
}

/* ───────── XML attr walk (после пересборки pool индексы те же) ───────── */

function attrBase(offset, attrStart, attrCount, attrSize, chunkSize) {
  const candidates = [
    offset + 16 + attrStart,
    offset + attrStart,
    offset + 36
  ];
  for (const b of candidates) {
    if (b >= offset + 20 && b + Math.max(attrCount, 1) * attrSize <= offset + chunkSize + 4) {
      return b;
    }
  }
  return offset + 36;
}

function patchTypedVersionCode(bytes, poolStrings, versionCode, report) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iVC = poolStrings.indexOf('versionCode');
  if (iVC < 0) {
    report.details.push('versionCode: имя атрибута не в pool');
    return;
  }
  const code = parseInt(versionCode, 10);
  if (Number.isNaN(code)) return;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = readU32(view, offset);
    const size = readU32(view, offset + 4);
    if (size < 8 || offset + size > bytes.length) break;

    if (type === 0x00100102) {
      const attrStart = readU16(view, offset + 24);
      const attrSize = readU16(view, offset + 26) || 20;
      const attrCount = readU16(view, offset + 28);
      const base = attrBase(offset, attrStart, attrCount, attrSize, size);

      for (let a = 0; a < attrCount; a++) {
        const attrOff = base + a * attrSize;
        if (attrOff + 20 > offset + size) break;
        const attrNameIdx = readU32(view, attrOff + 4);
        if (attrNameIdx === iVC) {
          writeU32(view, attrOff + 8, 0xffffffff);
          writeU32(view, attrOff + 16, code >>> 0);
          bytes[attrOff + 15] = 0x10;
          report.versionCode = true;
          report.details.push(`versionCode ATTR → ${code}`);
          return;
        }
      }
    }
    offset += size;
  }
  report.details.push('versionCode: атрибут не найден в XML');
}

/**
 * После смены label-строки: если label был TYPE_REFERENCE — переключить на STRING.
 */
function forceLabelToString(bytes, poolStrings, labelIndex, report) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iLabel = poolStrings.indexOf('label');
  if (iLabel < 0 || labelIndex < 0) return;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = readU32(view, offset);
    const size = readU32(view, offset + 4);
    if (size < 8 || offset + size > bytes.length) break;

    if (type === 0x00100102) {
      const attrStart = readU16(view, offset + 24);
      const attrSize = readU16(view, offset + 26) || 20;
      const attrCount = readU16(view, offset + 28);
      const elemNameIdx = readU32(view, offset + 20);
      const elemName = poolStrings[elemNameIdx] || '';
      const base = attrBase(offset, attrStart, attrCount, attrSize, size);

      for (let a = 0; a < attrCount; a++) {
        const attrOff = base + a * attrSize;
        if (attrOff + 20 > offset + size) break;
        const attrNameIdx = readU32(view, attrOff + 4);
        if (attrNameIdx !== iLabel) continue;
        if (elemName && elemName !== 'application' && elemName !== 'activity' && elemName !== 'activity-alias') {
          continue;
        }
        writeU32(view, attrOff + 8, labelIndex);
        writeU32(view, attrOff + 16, labelIndex);
        bytes[attrOff + 15] = 0x03;
        report.details.push(`label ATTR <${elemName || '?'}> → string index ${labelIndex}`);
        report.label = true;
      }
    }
    offset += size;
  }
}

function forceVersionNameToString(bytes, poolStrings, versionIndex, report) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iVN = poolStrings.indexOf('versionName');
  if (iVN < 0 || versionIndex < 0) return;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = readU32(view, offset);
    const size = readU32(view, offset + 4);
    if (size < 8 || offset + size > bytes.length) break;

    if (type === 0x00100102) {
      const attrStart = readU16(view, offset + 24);
      const attrSize = readU16(view, offset + 26) || 20;
      const attrCount = readU16(view, offset + 28);
      const base = attrBase(offset, attrStart, attrCount, attrSize, size);

      for (let a = 0; a < attrCount; a++) {
        const attrOff = base + a * attrSize;
        if (attrOff + 20 > offset + size) break;
        if (readU32(view, attrOff + 4) !== iVN) continue;
        writeU32(view, attrOff + 8, versionIndex);
        writeU32(view, attrOff + 16, versionIndex);
        bytes[attrOff + 15] = 0x03;
        report.details.push(`versionName ATTR → string index ${versionIndex}`);
        report.versionName = true;
      }
    }
    offset += size;
  }
}

/**
 * Главный патч: меняем строки в pool (любая длина) → rebuild → склеиваем файл.
 */


/** android:screenOrientation values (Res_value TYPE_INT_DEC / enum) */

/** android:screenOrientation values */
const ORIENT_ENUM = {
  portrait: 1,
  landscape: 0,
  auto: 10 // fullSensor
};

function writeScreenOrientationAttr(buf, attrOff, nsIdx, nameIdx, enumVal) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  writeU32(view, attrOff + 0, nsIdx >>> 0);
  writeU32(view, attrOff + 4, nameIdx >>> 0);
  writeU32(view, attrOff + 8, 0xffffffff);
  view.setUint16(attrOff + 12, 8, true);
  buf[attrOff + 14] = 0;
  buf[attrOff + 15] = 0x10; // TYPE_INT_DEC
  writeU32(view, attrOff + 16, enumVal >>> 0);
}

/**
 * Ставит screenOrientation на все activity.
 * Если атрибута нет — вставляет в первый activity.
 * @returns {Uint8Array}
 */
function forceOrientation(bytesIn, poolStrings, orientation, report) {
  const mode = ORIENT_ENUM[orientation] != null ? orientation : 'portrait';
  const enumVal = ORIENT_ENUM[mode] >>> 0;
  let bytes = bytesIn;
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const iOrient = poolStrings.indexOf('screenOrientation');
  if (iOrient < 0) {
    report.details.push('orientation: skip');
    return bytes;
  }

  let iNs = poolStrings.indexOf('http://schemas.android.com/apk/res/android');
  if (iNs < 0) iNs = 0xffffffff;

  let offset = 8;
  let patched = 0;
  let firstActivity = null;

  while (offset + 8 <= bytes.length) {
    const type = readU32(view, offset);
    const size = readU32(view, offset + 4);
    if (size < 8 || offset + size > bytes.length) break;

    if (type === 0x00100102) {
      const attrStart = readU16(view, offset + 24);
      const attrSize = readU16(view, offset + 26) || 20;
      const attrCount = readU16(view, offset + 28);
      const elemNameIdx = readU32(view, offset + 20);
      const elemName = poolStrings[elemNameIdx] || '';
      const base = attrBase(offset, attrStart, attrCount, attrSize, size);

      if (elemName === 'activity' || elemName === 'activity-alias') {
        let nsSample = iNs;
        for (let a = 0; a < attrCount; a++) {
          const attrOff = base + a * attrSize;
          if (attrOff + 20 > offset + size) break;
          const nsIdx = readU32(view, attrOff + 0);
          if (nsIdx !== 0xffffffff) nsSample = nsIdx;
          if (readU32(view, attrOff + 4) === iOrient) {
            writeScreenOrientationAttr(bytes, attrOff, nsIdx !== 0xffffffff ? nsIdx : iNs, iOrient, enumVal);
            patched++;
          }
        }
        if (!firstActivity) {
          firstActivity = { offset, size, attrSize, attrCount, base, nsSample };
        }
      }
    }
    offset += size;
  }

  if (patched > 0) {
    report.orientation = true;
    report.details.push('orientation ok');
    return bytes;
  }

  if (!firstActivity) {
    report.details.push('orientation: no activity');
    return bytes;
  }

  const act = firstActivity;
  const grow = act.attrSize || 20;
  const insertAt = act.base + act.attrCount * grow;
  const out = new Uint8Array(bytes.length + grow);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(bytes.subarray(insertAt), insertAt + grow);
  view = new DataView(out.buffer);

  writeU32(view, act.offset + 4, act.size + grow);
  view.setUint16(act.offset + 28, act.attrCount + 1, true);
  writeU32(view, 4, out.length);
  writeScreenOrientationAttr(out, insertAt, act.nsSample >>> 0, iOrient, enumVal);

  report.orientation = true;
  report.details.push('orientation ok');
  return out;
}

export function patchAndroidManifest(manifestBytes, opts = {}) {
  const original = new Uint8Array(manifestBytes);
  const report = {
    package: false,
    versionName: false,
    versionCode: false,
    label: false,
    orientation: false,
    details: [],
    poolStringsSample: []
  };

  let poolInfo;
  try {
    poolInfo = findAxmlPool(original);
  } catch (e) {
    report.details.push(String(e.message || e));
    return { bytes: original, report };
  }

  const pool = poolInfo.pool;
  const strings = pool.strings.slice();
  report.details.push(`pool: ${strings.length} строк, utf8=${pool.isUtf8}`);
  report.poolStringsSample = strings.filter(Boolean);

  // --- mutate strings by index ---
  let packageIdx = -1;
  let versionIdx = -1;
  let labelIdx = -1;

  if (opts.packageName) {
    packageIdx = strings.findIndex(looksPkg);
    if (packageIdx < 0) {
      // добавить новую строку
      packageIdx = strings.length;
      strings.push(opts.packageName);
      report.details.push(`package: добавлена новая строка [${packageIdx}]`);
    } else {
      report.details.push(`package: [${packageIdx}] "${strings[packageIdx]}" → "${opts.packageName}"`);
    }
    strings[packageIdx] = opts.packageName;
    report.package = true;
  }

  if (opts.versionName) {
    versionIdx = strings.findIndex(isVersionLike);
    if (versionIdx < 0) {
      versionIdx = strings.length;
      strings.push(opts.versionName);
      report.details.push(`versionName: добавлена новая строка [${versionIdx}]`);
    } else {
      report.details.push(`versionName: [${versionIdx}] "${strings[versionIdx]}" → "${opts.versionName}"`);
    }
    strings[versionIdx] = opts.versionName;
    report.versionName = true;
  }

  if (opts.appName) {
    // Всегда новая строка — не затираем "required", "theme" и т.п.
    labelIdx = strings.length;
    strings.push(opts.appName);
    report.details.push(`label: новая строка [${labelIdx}] "${opts.appName}"`);
    report.label = true;
  }

  if (opts.orientation && !strings.includes('screenOrientation')) {
    strings.push('screenOrientation');
    report.details.push('orientation: добавлено имя screenOrientation в pool');
  }

  // rebuild pool
  const newPool = rebuildPoolChunk({
    ...pool,
    strings,
    stringCount: strings.length
  });

  const oldPoolEnd = poolInfo.offset + poolInfo.size;
  const rest = original.slice(oldPoolEnd);

  // new file = header(8) is before pool; pool starts at poolInfo.offset
  const before = original.slice(0, poolInfo.offset);
  let assembled = new Uint8Array(before.length + newPool.length + rest.length);
  assembled.set(before, 0);
  assembled.set(newPool, before.length);
  assembled.set(rest, before.length + newPool.length);

  // update AXML file size at bytes 4
  const view = new DataView(assembled.buffer);
  writeU32(view, 4, assembled.length);

  report.details.push(`pool rebuild: ${poolInfo.size}b → ${newPool.length}b, file ${original.length}b → ${assembled.length}b`);

  // versionCode typed int
  if (opts.versionCode != null && opts.versionCode !== '') {
    patchTypedVersionCode(assembled, strings, opts.versionCode, report);
  }

  if (opts.orientation) {
    const next = forceOrientation(assembled, strings, opts.orientation, report);
    if (next && next !== assembled) assembled = next;
  }

  // force attributes to point at our string indices (label/versionName may have been refs)
  if (opts.versionName && versionIdx >= 0) {
    forceVersionNameToString(assembled, strings, versionIdx, report);
  }
  if (opts.appName && labelIdx >= 0) {
    forceLabelToString(assembled, strings, labelIdx, report);
  }

  // package on manifest is usually the string itself referenced by package attr — index may have changed only if we appended
  if (opts.packageName && packageIdx >= 0) {
    const view2 = new DataView(assembled.buffer);
    const iPkg = strings.indexOf('package');
    let offset = 8;
    while (offset + 8 <= assembled.length) {
      const type = readU32(view2, offset);
      const size = readU32(view2, offset + 4);
      if (size < 8 || offset + size > assembled.length) break;
      if (type === 0x00100102) {
        const attrStart = readU16(view2, offset + 24);
        const attrSize = readU16(view2, offset + 26) || 20;
        const attrCount = readU16(view2, offset + 28);
        const base = attrBase(offset, attrStart, attrCount, attrSize, size);
        for (let a = 0; a < attrCount; a++) {
          const attrOff = base + a * attrSize;
          if (attrOff + 20 > offset + size) break;
          const attrNameIdx = readU32(view2, attrOff + 4);
          if (attrNameIdx === iPkg || (iPkg < 0 && looksPkg(strings[readU32(view2, attrOff + 16)]))) {
            writeU32(view2, attrOff + 8, packageIdx);
            writeU32(view2, attrOff + 16, packageIdx);
            assembled[attrOff + 15] = 0x03;
            report.details.push(`package ATTR → index ${packageIdx}`);
          }
        }
      }
      offset += size;
    }
  }

  report.details.push(
    `итог: package=${report.package} versionName=${report.versionName} versionCode=${report.versionCode} label=${report.label} orientation=${report.orientation}`
  );

  return { bytes: assembled, report };
}

/** ARSC: пересборка первого string pool с заменой app name — упрощённо in-place only for equal-or-smaller; skip if longer */
export function patchResourcesArsc(arscBytes, appName) {
  if (!appName || !arscBytes) return { bytes: arscBytes, changed: false, details: [] };
  // Full ARSC rebuild is complex; try findPools-style only for display strings via simple UTF-8/16 replace in known app-like strings with rebuild of that pool only if we find RES_STRING_POOL

  const bytes = new Uint8Array(arscBytes);
  const details = [];
  // For now leave ARSC if label is forced to direct string in manifest — enough for launcher name
  details.push('arsc: пропуск (label задан прямой строкой в манифесте)');
  return { bytes, changed: false, details };
}
