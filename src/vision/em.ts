import { BaseSensor, type Anomaly, type SensorQuery, type Transport } from './base-sensor.js';
import { REDACTED_VALUE } from './redaction.js';

export type { Anomaly, SensorQuery, Transport } from './base-sensor.js';

export interface SemanticView {
  pageType: string;
  title: string;
  headings: string[];
  mainContentPreview: string;
  language: string;
}

export interface InteractiveElement {
  tag: string;
  text: string;
  selector: string;
  visible: boolean;
  disabled: boolean;
  /** ref estable del element map (e1, e2, …) — usable en acciones con `ref`. */
  ref?: string;
}

export interface FormField {
  tag: string;
  type: string;
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
  selector: string;
  /** ref estable del element map (e1, e2, …) — usable en acciones con `ref`. */
  ref?: string;
}

export interface InteractiveView {
  buttons: InteractiveElement[];
  links: InteractiveElement[];
  inputs: FormField[];
  total: number;
}

export interface StructuralView {
  totalElements: number;
  depth: number;
  iframes: number;
  images: number;
  scripts: number;
  forms: number;
  stylesheets: number;
}

export interface DOMSummary {
  url: string;
  readyState?: 'loading' | 'interactive' | 'complete';
  semantic: SemanticView;
  interactive: InteractiveView;
  structural: StructuralView;
}

export interface DOMQuery extends SensorQuery {
  view?: 'all' | 'semantic' | 'interactive' | 'structural';
}

export interface EMConfig {
  cacheTtlMs: number;
  maxInteractive: number;
}

const EXTRACTION_SCRIPT = `(function() {
  function getSelector(el) {
    if (el.id && /^[a-zA-Z]/.test(el.id)) return '#' + el.id;
    var testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + testid + '"]';
    var aria = el.getAttribute('aria-label');
    if (aria) return '[aria-label="' + aria + '"]';
    var name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var role = el.getAttribute('role');
    if (role && role !== 'presentation') return el.tagName.toLowerCase() + '[role="' + role + '"]';
    var ce = el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '') return '[contenteditable]';
    var cls = el.className;
    if (typeof cls === 'string' && cls.trim()) {
      var firstClass = cls.trim().split(/\\s+/)[0];
      if (firstClass && !firstClass.match(/^(css|sc|jsx|emotion|styled)/)) {
        return el.tagName.toLowerCase() + '.' + firstClass;
      }
    }
    var tag = el.tagName.toLowerCase();
    if (el.parentNode) {
      var sibs = Array.prototype.filter.call(el.parentNode.children, function(c) { return c.tagName === el.tagName; });
      if (sibs.length === 1) return tag;
      var idx = Array.prototype.indexOf.call(el.parentNode.children, el) + 1;
      return tag + ':nth-child(' + idx + ')';
    }
    return tag;
  }

  function visible(el) {
    if (!el || !el.offsetParent) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  // Sensitive-field detector — keep in sync with src/vision/redaction.ts.
  function sensitive(el) {
    var t = (el.type || el.getAttribute('type') || '').toString().toLowerCase();
    if (t === 'password' || t === 'hidden') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (!ac) return false;
    var tokens = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
    for (var j = 0; j < tokens.length; j++) {
      if (ac.indexOf(tokens[j]) !== -1) return true;
    }
    return false;
  }

  // --- Element map con refs (estilo Claude in Chrome) ---
  // keep in sync with src/vision/element-map.ts (createRefMap). El mapa vive
  // en la página entre extracciones: ref → WeakRef(el), WeakMap(el → ref) y
  // contador monótono. Se purga al inicio de cada extracción.
  var refMap = window.__yjElementMap;
  if (!refMap) { refMap = {}; window.__yjElementMap = refMap; }
  var refReverse = window.__yjElementReverseMap;
  if (!refReverse) { refReverse = new WeakMap(); window.__yjElementReverseMap = refReverse; }
  if (typeof window.__yjRefCounter !== 'number') window.__yjRefCounter = 0;
  for (var refKey in refMap) {
    var purgedEl = refMap[refKey] && refMap[refKey].deref ? refMap[refKey].deref() : null;
    if (!purgedEl || !document.contains(purgedEl)) delete refMap[refKey];
  }
  function assignRef(el) {
    var existing = refReverse.get(el);
    if (existing && refMap[existing]) return existing;
    window.__yjRefCounter += 1;
    var ref = 'e' + window.__yjRefCounter;
    refMap[ref] = new WeakRef(el);
    refReverse.set(el, ref);
    return ref;
  }

  // --- Semantic ---
  var title = document.title || '';
  var headingEls = document.querySelectorAll('h1, h2, h3');
  var headings = [];
  for (var i = 0; i < headingEls.length && i < 10; i++) {
    var t = headingEls[i].textContent.trim();
    if (t) headings.push(t.substring(0, 100));
  }
  var bodyText = document.body ? document.body.innerText : '';
  var lang = document.documentElement.lang || '';

  var pageType = 'unknown';
  if (document.querySelector('input[type=password]') && document.querySelector('form')) pageType = 'login';
  else if (document.querySelector('[role=dialog], .modal, [aria-modal=true]')) pageType = 'modal';
  else if (document.querySelector('nav') && document.querySelector('main, [role=main]')) pageType = 'dashboard';
  else if (headingEls.length > 0 && bodyText.length > 500) pageType = 'article';
  else if (document.querySelector('input[type=search], [role=searchbox], input[name=q], input[name=search]')) pageType = 'search';
  else if (document.querySelector('[data-testid*=chat], .chat-input, [class*=message-list]')) pageType = 'chat';
  else if (document.querySelectorAll('form input').length > 2) pageType = 'form';
  else if (title.indexOf('404') !== -1 || title.indexOf('Error') !== -1) pageType = 'error';

  // --- Interactive (compact) ---
  var buttonEls = document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], [contenteditable=true], [role=textbox], [role=searchbox]');
  var buttons = [];
  for (var i = 0; i < buttonEls.length && buttons.length < 15; i++) {
    var el = buttonEls[i];
    if (!visible(el)) continue;
    var text = el.textContent
      ? el.textContent.trim()
      : (sensitive(el) ? ${JSON.stringify(REDACTED_VALUE)} : (el.value || '').trim());
    if (!text && !el.getAttribute('aria-label') && !el.getAttribute('placeholder')) continue;
    buttons.push({
      tag: el.tagName,
      text: text.substring(0, 60),
      selector: getSelector(el),
      visible: true,
      disabled: el.disabled || false,
      ref: assignRef(el),
    });
  }

  var linkEls = document.querySelectorAll('a[href]');
  var links = [];
  for (var i = 0; i < linkEls.length && links.length < 10; i++) {
    var el = linkEls[i];
    if (!visible(el)) continue;
    var text = el.textContent.trim();
    if (!text) continue;
    links.push({
      tag: 'A',
      text: text.substring(0, 60),
      selector: getSelector(el),
      visible: true,
      disabled: false,
      ref: assignRef(el),
    });
  }

  var inputEls = document.querySelectorAll('input, textarea, select');
  var inputs = [];
  for (var i = 0; i < inputEls.length && inputs.length < 10; i++) {
    var el = inputEls[i];
    if (!visible(el)) continue;
    var label = '';
    if (el.id) {
      var labelEl = document.querySelector('label[for="' + el.id + '"]');
      if (labelEl) label = labelEl.textContent.trim();
    }
    if (!label && el.placeholder) label = el.placeholder;
    inputs.push({
      tag: el.tagName,
      type: el.type || el.tagName.toLowerCase(),
      name: el.name || '',
      label: label.substring(0, 50),
      placeholder: el.placeholder || '',
      required: el.required || false,
      selector: getSelector(el),
      ref: assignRef(el),
    });
  }

  // --- Structural ---
  var allEls = document.getElementsByTagName('*');
  var totalElements = allEls.length;
  var depth = 0;
  function measureDepth(el, d) {
    if (d > depth) depth = d;
    for (var i = 0; i < el.children.length; i++) {
      measureDepth(el.children[i], d + 1);
    }
  }
  measureDepth(document.body, 0);

  return JSON.stringify({
    url: location.href,
    readyState: document.readyState,
    semantic: {
      pageType: pageType,
      title: title,
      headings: headings,
      mainContentPreview: bodyText.substring(0, 300),
      language: lang,
    },
    interactive: {
      buttons: buttons,
      links: links,
      inputs: inputs,
      total: buttons.length + links.length + inputs.length,
    },
    structural: {
      totalElements: totalElements,
      depth: depth,
      iframes: document.querySelectorAll('iframe').length,
      images: document.querySelectorAll('img').length,
      scripts: document.querySelectorAll('script').length,
      forms: document.querySelectorAll('form').length,
      stylesheets: document.querySelectorAll('link[rel=stylesheet]').length,
    },
  });
})()`;

export class EMSensor extends BaseSensor<DOMSummary> {
  private config: EMConfig;
  private cached: DOMSummary | null = null;
  private cachedAt = 0;
  private cachedScope = '';
  private revision = 0;

  constructor(transport: Transport, config?: Partial<EMConfig>) {
    super(transport);
    this.config = { cacheTtlMs: 2000, maxInteractive: 50, ...config };
  }

  protected doSubscribe(): void {
    this.on('Page.frameNavigated', () => this.clear());
    this.on('Page.loadEventFired', () => this.clear());
  }

  async summarize(query?: DOMQuery): Promise<DOMSummary> {
    void query;
    const scope = this.scopeKey();
    const revision = this.revision;
    if (this.cached && this.cachedScope === scope && Date.now() - this.cachedAt < this.config.cacheTtlMs) {
      return this.cached;
    }

    const result = await this.transport.send('Runtime.evaluate', {
      expression: EXTRACTION_SCRIPT,
      returnByValue: true,
    });

    const json = result?.result?.value;
    if (!json) {
      throw new Error('EMSensor: Runtime.evaluate returned no data');
    }

    const data = JSON.parse(json) as DOMSummary;
    if (scope !== this.scopeKey() || revision !== this.revision) throw new Error('Document changed during DOM capture; observe again');
    this.cached = data;
    this.cachedScope = scope;
    this.cachedAt = Date.now();
    return data;
  }

  async getAnomalies(): Promise<Anomaly[]> {
    const summary = await this.summarize();
    const anomalies: Anomaly[] = [];
    if (summary.semantic.pageType === 'error') {
      anomalies.push({
        domain: 'dom',
        severity: 'warning',
        message: `Page appears to be an error page: "${summary.semantic.title}"`,
        timestamp: Date.now(),
      });
    }
    return anomalies;
  }

  clear(): void {
    this.revision++;
    this.cached = null;
    this.cachedAt = 0;
  }
}
