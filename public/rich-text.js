/* A deliberately small, inert Markdown renderer for untrusted agent messages.
 * All content enters through text nodes. Links and image syntax never navigate,
 * fetch resources, or acquire permissions from the surrounding desktop app. */
(() => {
  'use strict';

  const MAX_SOURCE = 256 * 1024;
  const MAX_LINES = 4000;
  const MAX_DEPTH = 5;
  const MAX_NODES = 12000;
  const listItem = line => line.match(/^( {0,12})([-+*]|\d{1,6}[.)])\s+(.+)$/);
  const fence = line => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const heading = line => line.match(/^ {0,3}(#{1,6})\s+(.+)$/);
  const quote = line => /^ {0,3}> ?/.test(line);
  const blank = line => !line.trim();
  const word = value => !!value && /[\p{L}\p{N}_]/u.test(value);

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function text(parent, value) {
    if (value) parent.append(document.createTextNode(value));
  }

  function find(source, token, from, budget) {
    if (budget.work <= 0) return -1;
    const result = source.indexOf(token, from);
    budget.work -= (result < 0 ? source.length : result) - from + token.length;
    return result;
  }

  function inline(parent, source, budget, depth = 0) {
    if (depth >= MAX_DEPTH || budget.nodes <= 0 || budget.work <= 0) {
      text(parent, source); return;
    }
    let i = 0, plain = 0;
    const flush = end => { text(parent, source.slice(plain, end)); };
    while (i < source.length && budget.nodes > 0 && budget.work > 0) {
      const char = source[i];
      if (char === '\\' && /[\\`*_[\]{}()#+.!>|~\-]/.test(source[i + 1] || '')) {
        flush(i); text(parent, source[i + 1]); i += 2; plain = i; budget.nodes--; continue;
      }
      // Preserve raw HTML literally, including Markdown-looking attributes.
      if (char === '<') {
        const end = find(source, '>', i + 1, budget);
        if (end >= 0) { flush(i); text(parent, source.slice(i, end + 1)); i = plain = end + 1; budget.nodes--; continue; }
      }
      if (char === '[' || (char === '!' && source[i + 1] === '[')) {
        const image = char === '!', start = i + (image ? 2 : 1);
        const middle = find(source, '](', start, budget);
        const end = middle >= 0 ? find(source, ')', middle + 2, budget) : -1;
        if (middle >= 0 && end >= 0) {
          const address = source.slice(middle + 2, end);
          flush(i);
          if (!image && /^https?:\/\/[^\s<>]+$/i.test(address)) {
            const link = element('span', 'rich-text-link');
            inline(link, source.slice(start, middle), budget, depth + 1);
            text(link, ' (');
            const url = element('span', 'rich-text-url'); url.textContent = address;
            link.append(url); text(link, ')'); parent.append(link);
          } else text(parent, source.slice(i, end + 1));
          i = plain = end + 1; budget.nodes -= 3; continue;
        }
      }
      if (char === '`') {
        let length = 1;
        while (source[i + length] === '`') length++;
        const marker = '`'.repeat(length), end = find(source, marker, i + length, budget);
        if (end >= 0) {
          flush(i);
          const code = element('code'); code.textContent = source.slice(i + length, end);
          parent.append(code); i = plain = end + length; budget.nodes--; continue;
        }
        i += length; continue;
      }
      if (char === '*' || char === '_') {
        let length = source.startsWith(char.repeat(3), i) ? 3 : source.startsWith(char.repeat(2), i) ? 2 : 1;
        // Underscores inside identifiers and whitespace-delimited markers are text.
        if (/\s/.test(source[i + length] || ' ') || (char === '_' && word(source[i - 1]))) { i += length; continue; }
        const marker = char.repeat(length);
        let end = find(source, marker, i + length, budget);
        while (end >= 0 && (source[end - 1] === '\\' || /\s/.test(source[end - 1] || ' ') || (char === '_' && word(source[end + length])))) {
          end = find(source, marker, end + length, budget);
        }
        if (end > i + length) {
          flush(i);
          const emphasis = element(length === 1 ? 'em' : 'strong');
          if (length === 3) {
            const inner = element('em'); inline(inner, source.slice(i + length, end), budget, depth + 1); emphasis.append(inner);
          } else inline(emphasis, source.slice(i + length, end), budget, depth + 1);
          parent.append(emphasis); i = plain = end + length; budget.nodes -= 2; continue;
        }
        i += length; continue;
      }
      i++;
    }
    text(parent, source.slice(plain));
  }

  function tableCells(line) {
    let value = line.trim();
    if (!value.includes('|')) return null;
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = []; let current = '', ticks = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '\\' && value[i + 1] === '|') { current += '\\|'; i++; continue; }
      if (char === '`') {
        let count = 1; while (value[i + count] === '`') count++;
        if (!ticks) ticks = count; else if (ticks === count) ticks = 0;
        current += '`'.repeat(count); i += count - 1; continue;
      }
      if (char === '|' && !ticks) { cells.push(current.trim()); current = ''; }
      else current += char;
      if (cells.length > 24) return null;
    }
    cells.push(current.trim()); return cells.length <= 24 ? cells : null;
  }

  function tableAt(lines, index) {
    if (index + 1 >= lines.length || !lines[index + 1].includes('-')) return null;
    const headers = tableCells(lines[index]), rules = tableCells(lines[index + 1]);
    if (!headers || !rules || headers.length !== rules.length || !rules.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
    return { headers, rules };
  }

  function startsBlock(lines, index) {
    const line = lines[index];
    return blank(line) || fence(line) || heading(line) || quote(line) || listItem(line) || tableAt(lines, index);
  }

  function blocks(parent, lines, budget, depth = 0) {
    if (depth >= MAX_DEPTH || budget.nodes <= 0 || budget.work <= 0) {
      const fallback = element('pre', 'rich-text-plain'); fallback.textContent = lines.join('\n'); parent.append(fallback); return;
    }
    let i = 0;
    while (i < lines.length) {
      if (budget.nodes <= 0 || budget.work <= 0) {
        const remainder = element('pre', 'rich-text-plain'); remainder.textContent = lines.slice(i).join('\n'); parent.append(remainder); break;
      }
      const line = lines[i];
      if (blank(line)) { i++; continue; }
      const codeStart = fence(line);
      if (codeStart) {
        const marker = codeStart[1], body = []; i++;
        while (i < lines.length) {
          const close = lines[i].match(/^ {0,3}(`+|~+)\s*$/);
          if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i++; break; }
          body.push(lines[i++]);
        }
        const wrapper = element('div', 'rich-text-code');
        const label = element('div', 'rich-text-code-label'); label.textContent = codeStart[2].trim() || '代码';
        const pre = element('pre'), code = element('code'); code.textContent = body.join('\n');
        pre.append(code); wrapper.append(label, pre); parent.append(wrapper); budget.nodes -= 4; continue;
      }
      const title = heading(line);
      if (title) {
        const h = element('h' + Math.min(6, title[1].length + 2));
        inline(h, title[2].replace(/\s+#+\s*$/, ''), budget); parent.append(h); i++; budget.nodes--; continue;
      }
      if (quote(line)) {
        const quoted = [];
        while (i < lines.length && quote(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        const node = element('blockquote'); blocks(node, quoted, budget, depth + 1); parent.append(node); budget.nodes--; continue;
      }
      const first = listItem(line);
      if (first) {
        const indent = first[1].length, ordered = /^\d/.test(first[2]);
        const list = element(ordered ? 'ol' : 'ul');
        if (ordered && parseInt(first[2], 10) !== 1) list.setAttribute('start', String(parseInt(first[2], 10)));
        while (i < lines.length) {
          const item = listItem(lines[i]);
          if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
          const li = element('li'); inline(li, item[3], budget); i++; budget.nodes--;
          const continuation = [];
          while (i < lines.length) {
            const leading = lines[i].match(/^ */)[0].length;
            if (lines[i].trim() && leading >= indent + 2) { continuation.push(lines[i++].slice(indent + 2)); continue; }
            if (blank(lines[i]) && i + 1 < lines.length && lines[i + 1].startsWith(' '.repeat(indent + 2))) { continuation.push(''); i++; continue; }
            break;
          }
          if (continuation.length) blocks(li, continuation, budget, depth + 1);
          list.append(li);
          if (i < lines.length && blank(lines[i]) && i + 1 < lines.length) {
            const next = listItem(lines[i + 1]);
            if (next && next[1].length === indent && /^\d/.test(next[2]) === ordered) i++;
          }
          if (budget.nodes <= 0 || budget.work <= 0) break;
        }
        parent.append(list); budget.nodes--; continue;
      }
      const grid = tableAt(lines, i);
      if (grid) {
        const wrapper = element('div', 'rich-text-table');
        wrapper.setAttribute('tabindex', '0'); wrapper.setAttribute('aria-label', '消息中的表格');
        const table = element('table'), head = element('thead'), row = element('tr'), body = element('tbody');
        const cell = (tag, value, index) => {
          const node = element(tag), rule = grid.rules[index];
          if (tag === 'th') node.setAttribute('scope', 'col');
          node.setAttribute('data-align', rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : 'left');
          inline(node, value, budget); budget.nodes--; return node;
        };
        grid.headers.forEach((value, index) => row.append(cell('th', value, index))); head.append(row); i += 2;
        let rows = 0;
        while (i < lines.length && rows < 200 && budget.nodes > 0 && budget.work > 0) {
          const values = tableCells(lines[i]); if (!values || values.length !== grid.headers.length) break;
          const tr = element('tr'); values.forEach((value, index) => tr.append(cell('td', value, index))); body.append(tr); i++; rows++;
        }
        table.append(head, body); wrapper.append(table); parent.append(wrapper); budget.nodes -= 5; continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && !startsBlock(lines, i)) paragraph.push(lines[i++]);
      const p = element('p'); inline(p, paragraph.join('\n'), budget); parent.append(p); budget.nodes--;
    }
  }

  function render(value) {
    const source = typeof value === 'string' ? value : String(value ?? '');
    const root = element('div', 'rich-text');
    if (source.length > MAX_SOURCE || (source.match(/\n/g) || []).length >= MAX_LINES) {
      const pre = element('pre', 'rich-text-plain'); pre.textContent = source; root.append(pre); return root;
    }
    blocks(root, source.replace(/\r\n?/g, '\n').split('\n'), { work: Math.min(4_000_000, source.length * 16 + 8192), nodes: MAX_NODES });
    return root;
  }

  window.noahRichText = Object.freeze({ render });
})();
