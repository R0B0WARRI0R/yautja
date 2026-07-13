export type SensorDomain = 'network' | 'dom' | 'console' | 'performance' | 'security';

interface KeywordEntry {
  words: string[];
  weight: number;
}

const DOMAIN_KEYWORDS: Record<SensorDomain, KeywordEntry[]> = {
  network: [
    { words: ['slow', 'lento', 'latency', 'timeout', 'request', 'api', 'cors', 'xhr', 'fetch', 'ajax', 'loading', 'cargando', 'download', 'descarga', 'bandwidth', 'transfer', 'tamaño', 'size'], weight: 1.0 },
    { words: ['failed', 'error', 'falló', '404', '500', '503', 'blocked', 'bloqueado'], weight: 1.2 },
    { words: ['websocket', 'sse', 'streaming', 'real-time', 'realtime'], weight: 1.0 },
  ],
  dom: [
    { words: ['click', 'button', 'form', 'input', 'type', 'escribir', 'interact', 'element', 'select', 'dropdown'], weight: 1.0 },
    { words: ['layout', 'css', 'style', 'visible', 'hidden', 'oculto', 'display'], weight: 0.9 },
    { words: ['modal', 'dialog', 'popup', 'menu', 'navigation', 'nav'], weight: 0.9 },
    { words: ['content', 'text', 'heading', 'title', 'structure', 'estructura', 'page', 'página'], weight: 0.7 },
  ],
  console: [
    { words: ['error', 'warning', 'log', 'console', 'exception', 'crash', 'bug', 'broken', 'roto', 'fallo'], weight: 1.0 },
    { words: ['deprecated', 'obsoleto', 'stack', 'trace', 'traceback'], weight: 0.9 },
    { words: ['uncaught', 'undefined', 'null', 'nan', 'typeerror', 'referenceerror'], weight: 1.1 },
  ],
  performance: [
    { words: ['slow', 'lento', 'fast', 'rápido', 'performance', 'rendimiento', 'optimize', 'optimizar', 'speed', 'velocidad'], weight: 1.0 },
    { words: ['memory', 'memoria', 'leak', 'heap', 'gc', 'garbage'], weight: 1.0 },
    { words: ['cpu', 'thread', 'blocking', 'jank', 'freeze', 'colgado', 'hang'], weight: 1.0 },
    { words: ['layout', 'reflow', 'repaint', 'render', 'fps', 'animation', 'animación'], weight: 0.9 },
    { words: ['load time', 'tti', 'fcp', 'lcp', 'metric', 'métrica'], weight: 0.8 },
  ],
  security: [
    { words: ['security', 'seguridad', 'secure', 'insecure', 'vulnerable', 'csp', 'mixed content', 'mezclado'], weight: 1.0 },
    { words: ['certificate', 'certificado', 'ssl', 'tls', 'https', 'http'], weight: 0.9 },
    { words: ['xss', 'injection', 'cors', 'csrf', 'auth', 'token', 'cookie'], weight: 1.0 },
    { words: ['tracking', 'third-party', 'terceros', 'fingerprint', 'huella'], weight: 0.8 },
  ],
};

export function scoreDomain(question: string, domain: SensorDomain): number {
  const normalized = question.toLowerCase();
  const entries = DOMAIN_KEYWORDS[domain];
  let score = 0;
  for (const entry of entries) {
    for (const word of entry.words) {
      if (normalized.includes(word)) {
        score = Math.max(score, entry.weight);
      }
    }
  }
  return score;
}

export function selectDomains(question: string, threshold = 0.5): SensorDomain[] {
  const allDomains: SensorDomain[] = ['network', 'dom', 'console', 'performance', 'security'];
  const scored = allDomains
    .map((d) => ({ domain: d, score: scoreDomain(question, d) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.domain);
}

export function getTopDomain(question: string): SensorDomain | null {
  const domains = selectDomains(question);
  return domains[0] ?? null;
}
