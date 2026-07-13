export interface Transport {
  on(event: string, handler: (params: any) => void): () => void;
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface ElementMatch {
  selector: string;
  tag: string;
  text: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  href?: string;
  visible: boolean;
  score: number;
  editable?: boolean;
  inputType?: 'input' | 'textarea' | 'contenteditable' | 'rich-text';
}

export class ElementFinder {
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async find(query: string, limit = 10): Promise<ElementMatch[]> {
    const js = `(() => {
      const query = ${JSON.stringify(query)};
      const q = query.toLowerCase().trim();
      const words = q.split(/\\s+/);
      const interactiveSelectors = [
        'a', 'button', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="tab"]',
        '[role="menuitem"]', '[role="option"]', '[role="textbox"]', '[role="searchbox"]',
        '[onclick]', '[tabindex]',
        '[contenteditable="true"]', '[contenteditable=""]',
        'label', 'summary'
      ];
      const all = document.querySelectorAll(interactiveSelectors.join(', '));
      const results = [];
      const STOP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'HEAD']);

      for (const el of all) {
        if (STOP_TAGS.has(el.tagName)) continue;
        const text = (el.textContent || '').trim().substring(0, 80);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const title = el.getAttribute('title') || '';
        const alt = el.getAttribute('alt') || '';
        const name = el.getAttribute('name') || '';
        const id = el.id || '';
        const type = el.getAttribute('type') || el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const href = el.getAttribute('href') || '';
        const ce = el.getAttribute('contenteditable');
        const isEditable = ce === 'true' || ce === '' || role === 'textbox' || role === 'searchbox'
          || el.isContentEditable;

        let inputType = 'input';
        if (el.tagName === 'TEXTAREA') inputType = 'textarea';
        else if (isEditable) inputType = 'contenteditable';

        const haystack = [text, ariaLabel, placeholder, title, alt, name, id, role, type]
          .join(' ').toLowerCase();

        let score = 0;
        let exactMatch = false;

        if (haystack === q || text.toLowerCase() === q) {
          score = 1000;
          exactMatch = true;
        } else if (haystack.includes(q)) {
          score = 800;
        } else {
          let wordHits = 0;
          for (const w of words) {
            if (haystack.includes(w)) wordHits++;
          }
          score = (wordHits / words.length) * 500;
        }

        if (score === 0) continue;

        if (exactMatch) score += 200;
        if (text.toLowerCase() === q) score += 300;
        if (ariaLabel.toLowerCase() === q) score += 100;
        if (el.tagName === 'BUTTON' || role === 'button') score += 50;
        if (el.tagName === 'A' || role === 'link') score += 30;
        if (isEditable && q.match(/input|search|type|write|ask|query|box|field|text/i)) score += 100;

        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && rect.top >= 0;

        let selector = '';
        if (id) selector = '#' + CSS.escape(id);
        else if (name) selector = el.tagName.toLowerCase() + '[name="' + name + '"]';
        else if (ariaLabel) selector = '[aria-label="' + ariaLabel + '"]';
        else if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
          selector = el.tagName.toLowerCase() + (cls ? '.' + cls : '');
        } else {
          selector = el.tagName.toLowerCase();
        }

        results.push({
          selector, tag: el.tagName, text, type, role, ariaLabel, placeholder, href,
          visible, score, editable: isEditable, inputType
        });
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, ${limit});
    })()`;

    const result = await this.transport.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
    });
    return result?.result?.value || [];
  }

  async findOne(query: string): Promise<ElementMatch | null> {
    const results = await this.find(query, 1);
    return results[0] || null;
  }
}
