/**
 * responseDiff (P15) — compare two response bodies.
 *
 * JSON deep diff producing { added, removed, changed } with dotted paths
 * (BOLA-style: an unexpected extra field in B shows up in `added`).
 * Non-JSON input falls back to a line-based diff.
 * `ignorePaths` filters dotted paths (exact match or prefix with '.').
 */

export interface DiffEntry {
  path: string;
  a?: unknown;
  b?: unknown;
}

export interface ResponseDiffResult {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  format: 'json' | 'text';
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isIgnored(path: string, ignorePaths: string[]): boolean {
  return ignorePaths.some((p) => path === p || path.startsWith(p + '.'));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function diffJson(
  a: unknown,
  b: unknown,
  path: string,
  ignore: string[],
  out: ResponseDiffResult,
): void {
  if (isIgnored(path, ignore)) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in a)) {
        if (!isIgnored(childPath, ignore)) out.added.push({ path: childPath, b: (b as any)[key] });
      } else if (!(key in b)) {
        if (!isIgnored(childPath, ignore)) out.removed.push({ path: childPath, a: (a as any)[key] });
      } else {
        diffJson((a as any)[key], (b as any)[key], childPath, ignore, out);
      }
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.changed.push({ path: path || '$', a, b });
    }
    return;
  }

  if (a !== b) {
    out.changed.push({ path: path || '$', a, b });
  }
}

export function responseDiff(a: string, b: string, ignorePaths: string[] = []): ResponseDiffResult {
  const ja = tryJson(a);
  const jb = tryJson(b);

  if (ja !== undefined && jb !== undefined) {
    const out: ResponseDiffResult = { added: [], removed: [], changed: [], format: 'json' };
    diffJson(ja, jb, '', ignorePaths, out);
    return out;
  }

  // Text fallback: line-based diff
  const out: ResponseDiffResult = { added: [], removed: [], changed: [], format: 'text' };
  const la = a.split('\n');
  const lb = b.split('\n');
  const setA = new Set(la);
  const setB = new Set(lb);
  lb.forEach((line, i) => {
    if (!setA.has(line)) out.added.push({ path: `line ${i + 1}`, b: line });
  });
  la.forEach((line, i) => {
    if (!setB.has(line)) out.removed.push({ path: `line ${i + 1}`, a: line });
  });
  return out;
}
