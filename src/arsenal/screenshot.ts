/**
 * Screenshot robusto (mejora 4 del informe RE de Claude in Chrome):
 * plan de intentos formato/calidad con guardarraíl de tamaño,
 * validación/normalización de `clip` y script de `zoom` (recorte con
 * canvas inyectado en la página vía Runtime.evaluate).
 *
 * Lógica pura, sin CDP, para que sea testeable unitariamente.
 */

/**
 * Guardarraíl: nunca devolver al LLM un payload base64 mayor que esto.
 * Si el resultado lo excede, el translator reintenta con jpeg y quality
 * decreciente (80 → 60) y, si sigue excediendo, falla con
 * SCREENSHOT_TOO_LARGE en vez de soltar un blob gigante.
 */
export const MAX_BASE64_CHARS = 900_000;

export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

/** Rectángulo del zoom en píxeles CSS del viewport visible. */
export interface ZoomRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotAttempt {
  format: 'png' | 'jpeg';
  quality?: number;
}

export function isValidClip(clip: unknown): clip is ScreenshotClip {
  if (!clip || typeof clip !== 'object') return false;
  const c = clip as ScreenshotClip;
  return (
    [c.x, c.y, c.width, c.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    c.width > 0 &&
    c.height > 0
  );
}

/** Mapea el clip de la acción al shape de Page.captureScreenshot (scale default 1). */
export function normalizeClip(clip: ScreenshotClip): Required<ScreenshotClip> {
  return { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 };
}

export function isValidRegion(region: unknown): region is ZoomRegion {
  return isValidClip(region);
}

/**
 * Secuencia de intentos: primero el formato pedido; si el base64 excede
 * MAX_BASE64_CHARS, downgrade a jpeg 80 y luego jpeg 60. Se omiten
 * fallbacks idénticos al primer intento (p.ej. si ya se pidió jpeg 80).
 */
export function planScreenshotAttempts(
  requestedFormat: 'png' | 'jpeg',
  requestedQuality?: number,
): ScreenshotAttempt[] {
  const first: ScreenshotAttempt = { format: requestedFormat };
  if (requestedFormat === 'jpeg' && requestedQuality !== undefined) {
    first.quality = requestedQuality;
  }
  const fallbacks: ScreenshotAttempt[] = [
    { format: 'jpeg', quality: 80 },
    { format: 'jpeg', quality: 60 },
  ];
  const rest = fallbacks.filter(
    (f) => !(f.format === first.format && f.quality === first.quality),
  );
  return [first, ...rest];
}

/**
 * Script de zoom: decodifica el PNG de la captura completa y recorta el
 * rectángulo con un canvas (patrón `zoom` de Claude in Chrome).
 *
 * `region` está en píxeles CSS del viewport; el script la convierte a
 * píxeles de imagen con el ratio naturalWidth/innerWidth (cubre DPR > 1).
 * Devuelve el base64 del recorte (sin prefijo data:), o '' si la región
 * queda fuera de la imagen.
 */
export function buildZoomScript(
  base64Png: string,
  region: ZoomRegion,
  format: 'png' | 'jpeg',
  quality?: number,
): string {
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const toDataUrl =
    format === 'jpeg'
      ? `canvas.toDataURL('${mime}', ${(quality ?? 80) / 100})`
      : `canvas.toDataURL('${mime}')`;
  return `(async () => {
  const region = ${JSON.stringify({ x: region.x, y: region.y, width: region.width, height: region.height })};
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('screenshotZoom: image decode failed'));
    img.src = ${JSON.stringify(`data:image/png;base64,${base64Png}`)};
  });
  const sx = img.naturalWidth / (window.innerWidth || img.naturalWidth);
  const sy = img.naturalHeight / (window.innerHeight || img.naturalHeight);
  const cx = Math.max(0, Math.round(region.x * sx));
  const cy = Math.max(0, Math.round(region.y * sy));
  const cw = Math.min(img.naturalWidth - cx, Math.round(region.width * sx));
  const ch = Math.min(img.naturalHeight - cy, Math.round(region.height * sy));
  if (cw <= 0 || ch <= 0) return '';
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
  const url = ${toDataUrl};
  return url.split(',')[1] || '';
})()`;
}
