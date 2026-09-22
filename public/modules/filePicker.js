export function pickFile(accept = '*/*', multiple = false) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = () => {
      const files = multiple ? Array.from(input.files) : input.files[0];
      document.body.removeChild(input);
      if (!files || (Array.isArray(files) && files.length === 0)) {
        reject(new Error('No file selected'));
        return;
      }
      resolve(files);
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      reject(new Error('Cancelled'));
    };

    input.click();
  });
}

export function pickFolder() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = () => {
      const files = Array.from(input.files);
      document.body.removeChild(input);
      if (!files.length) {
        reject(new Error('No folder selected'));
        return;
      }
      resolve(files);
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      reject(new Error('Cancelled'));
    };

    input.click();
  });
}

export async function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

export async function folderToFilesMap(fileList) {
  const map = {};
  for (const file of fileList) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split('/');
    const relative = parts.length > 1 ? parts.slice(1).join('/') : file.name;
    map[relative] = new Uint8Array(await file.arrayBuffer());
  }
  return map;
}

export async function zipToFilesMap(arrayBuffer) {
  const { loadZip, extractWebFiles } = await import('./zipHandler.js');
  const zip = await loadZip(arrayBuffer);
  return extractWebFiles(zip);
}
