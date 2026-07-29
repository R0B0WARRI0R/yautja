import { describe, it, expect } from 'vitest';
import {
  MAX_BASE64_CHARS,
  buildZoomScript,
  isValidClip,
  isValidRegion,
  normalizeClip,
  planScreenshotAttempts,
} from '../../src/arsenal/screenshot.js';

describe('planScreenshotAttempts', () => {
  it('png default: png first, then jpeg 80 and jpeg 60 fallbacks', () => {
    expect(planScreenshotAttempts('png')).toEqual([
      { format: 'png' },
      { format: 'jpeg', quality: 80 },
      { format: 'jpeg', quality: 60 },
    ]);
  });

  it('jpeg with explicit quality first, then decreciente', () => {
    expect(planScreenshotAttempts('jpeg', 90)).toEqual([
      { format: 'jpeg', quality: 90 },
      { format: 'jpeg', quality: 80 },
      { format: 'jpeg', quality: 60 },
    ]);
  });

  it('jpeg 80 requested: no duplicate fallback', () => {
    expect(planScreenshotAttempts('jpeg', 80)).toEqual([
      { format: 'jpeg', quality: 80 },
      { format: 'jpeg', quality: 60 },
    ]);
  });

  it('quality is ignored for png first attempt (CDP only accepts it for jpeg)', () => {
    const [first] = planScreenshotAttempts('png', 40);
    expect(first).toEqual({ format: 'png' });
  });
});

describe('isValidClip / normalizeClip', () => {
  it('accepts a full clip', () => {
    expect(isValidClip({ x: 0, y: 0, width: 100, height: 50 })).toBe(true);
  });

  it('rejects zero/negative dimensions and missing fields', () => {
    expect(isValidClip({ x: 0, y: 0, width: 0, height: 50 })).toBe(false);
    expect(isValidClip({ x: 0, y: 0, width: 100, height: -1 })).toBe(false);
    expect(isValidClip({ x: 0, y: 0, width: 100 })).toBe(false);
    expect(isValidClip(null)).toBe(false);
    expect(isValidClip('clip')).toBe(false);
  });

  it('normalizeClip defaults scale to 1 and preserves explicit scale', () => {
    expect(normalizeClip({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4, scale: 1 });
    expect(normalizeClip({ x: 1, y: 2, width: 3, height: 4, scale: 2 })).toEqual({ x: 1, y: 2, width: 3, height: 4, scale: 2 });
  });
});

describe('isValidRegion', () => {
  it('shares the clip validation rules', () => {
    expect(isValidRegion({ x: 10, y: 20, width: 30, height: 40 })).toBe(true);
    expect(isValidRegion({ x: 10, y: 20, width: 0, height: 40 })).toBe(false);
  });
});

describe('buildZoomScript', () => {
  it('embeds the source PNG and the region', () => {
    const script = buildZoomScript('QUJD', { x: 10, y: 20, width: 30, height: 40 }, 'png');
    expect(script).toContain('data:image/png;base64,QUJD');
    expect(script).toContain('"x":10');
    expect(script).toContain('"width":30');
    expect(script).toContain('drawImage');
    expect(script).toContain("canvas.toDataURL('image/png')");
  });

  it('jpeg passes quality/100 to toDataURL', () => {
    const script = buildZoomScript('QUJD', { x: 0, y: 0, width: 5, height: 5 }, 'jpeg', 80);
    expect(script).toContain("canvas.toDataURL('image/jpeg', 0.8)");
  });

  it('jpeg defaults quality to 80', () => {
    const script = buildZoomScript('QUJD', { x: 0, y: 0, width: 5, height: 5 }, 'jpeg');
    expect(script).toContain("canvas.toDataURL('image/jpeg', 0.8)");
  });

  it('converts CSS pixels to image pixels via naturalWidth/innerWidth ratio (DPR)', () => {
    const script = buildZoomScript('QUJD', { x: 0, y: 0, width: 5, height: 5 }, 'png');
    expect(script).toContain('img.naturalWidth / (window.innerWidth');
    expect(script).toContain('img.naturalHeight / (window.innerHeight');
  });

  it('returns base64 without the data: prefix and guards empty crops', () => {
    const script = buildZoomScript('QUJD', { x: 0, y: 0, width: 5, height: 5 }, 'png');
    expect(script).toContain("url.split(',')[1] || ''");
    expect(script).toContain("if (cw <= 0 || ch <= 0) return ''");
  });
});

describe('MAX_BASE64_CHARS', () => {
  it('is a 900k guardrail', () => {
    expect(MAX_BASE64_CHARS).toBe(900_000);
  });
});
