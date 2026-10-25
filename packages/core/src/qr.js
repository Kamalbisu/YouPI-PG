import { qrcode } from './qr-lib.js';

export class QrCode {
  static encode(text, errorCorrection = 'M') {
    const qr = qrcode(0, errorCorrection);
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const matrix = [];
    for (let r = 0; r < count; r++) {
      const row = [];
      for (let c = 0; c < count; c++) {
        row.push(qr.isDark(r, c) ? 1 : 0);
      }
      matrix.push(row);
    }
    return matrix;
  }
}

export function generateQrSvg(text, boxSize = 240, errorCorrection = 'M') {
  const matrix = QrCode.encode(text, errorCorrection);
  const numModules = matrix.length;
  const moduleSize = boxSize / numModules;

  let rects = '';
  for (let r = 0; r < numModules; r++) {
    for (let c = 0; c < numModules; c++) {
      if (matrix[r][c] === 1) {
        const x = (c * moduleSize).toFixed(2);
        const y = (r * moduleSize).toFixed(2);
        const s = (moduleSize + 0.05).toFixed(2);
        rects += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="#0f172a" />\n`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${boxSize} ${boxSize}" width="100%" height="100%" shape-rendering="crispEdges">
  <rect width="${boxSize}" height="${boxSize}" fill="#ffffff" rx="8" />
  ${rects}
</svg>`;
}

export const generateQrMatrix = (text, errorCorrection = 'M') => QrCode.encode(text, errorCorrection);
