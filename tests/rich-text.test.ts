import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

class TextNode {
  readonly tagName = '#text';
  textContent: string;
  constructor(value: string) { this.textContent = value; }
}
class Element {
  children: Array<Element | TextNode> = [];
  attributes: Record<string, string> = {};
  className = '';
  tagName: string;
  constructor(tag: string) { this.tagName = tag; }
  append(...children: Array<Element | TextNode>) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  set textContent(value: string) { this.children = [new TextNode(value)]; }
  get textContent(): string { return this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Markdown must never be parsed as HTML'); }
}
const source = readFileSync(new URL('../public/rich-text.js', import.meta.url), 'utf8');
const context = createContext({
  window: {},
  document: { createElement: (tag: string) => new Element(tag), createTextNode: (value: string) => new TextNode(value) },
});
runInContext(source, context);
function render(markdown: string): Element {
  context.input = markdown;
  return runInContext('window.noahRichText.render(input)', context, { timeout: 2000 });
}
function all(root: Element, tag?: string): Element[] {
  return [root, ...root.children.filter((child): child is Element => child instanceof Element).flatMap(child => all(child))]
    .filter(node => !tag || node.tagName === tag);
}

test('agent prose has semantic paragraphs, restrained headings, emphasis and inert inline code', () => {
  const root = render('# 共同的计划\n\n先 **验证边界**，再 *讨论*。使用 `noah_send`。\n保留换行。\n\n### C#');
  assert.equal(root.className, 'rich-text');
  assert.equal(all(root, 'h3')[0].textContent, '共同的计划');
  assert.equal(all(root, 'h5')[0].textContent, 'C#');
  assert.equal(all(root, 'strong')[0].textContent, '验证边界');
  assert.equal(all(root, 'em')[0].textContent, '讨论');
  assert.equal(all(root, 'code')[0].textContent, 'noah_send');
  assert.match(all(root, 'p')[0].textContent, /\n保留换行。/);
  const escaped = render('\\*literal\\* and task_run_id; ***both***');
  assert.match(escaped.textContent, /^\*literal\* and task_run_id;/);
  assert.equal(all(escaped, 'strong')[0].textContent, 'both');
  assert.equal(all(escaped, 'em')[0].textContent, 'both');
});

test('fenced code keeps raw content, blank lines and language names without executing markup', () => {
  const root = render('```html\n<script>alert("agent")</script>\n\n**not bold**\n```\n\n~~~python\nprint(1)\n~~~');
  assert.deepEqual(all(root, 'code').map(node => node.textContent), ['<script>alert("agent")</script>\n\n**not bold**', 'print(1)']);
  assert.deepEqual(all(root).filter(node => node.className === 'rich-text-code-label').map(node => node.textContent), ['html', 'python']);
  assert.equal(all(root, 'script').length, 0);
  assert.equal(all(root, 'strong').length, 0);
  assert.equal(all(render('```text\nAn unfinished response'), 'code')[0].textContent, 'An unfinished response');
});

test('ordered, nested and quoted discussion points retain their structure and content', () => {
  const root = render('3. 第一个决定\n   - 子项 A\n   - 子项 B\n4. 下一个决定\n\n> **待确认**\n>\n> - 一个分歧');
  assert.equal(all(root, 'ol')[0].attributes.start, '3');
  assert.equal(all(root, 'ul').length, 2);
  assert.equal(all(root, 'li').length, 5);
  assert.equal(all(root, 'blockquote')[0].textContent, '待确认一个分歧');
  assert.match(root.textContent, /子项 A子项 B/);
});

test('small comparison tables support column alignment, code and escaped pipe characters', () => {
  const root = render('| Agent | 结论 |\n| :--- | ---: |\n| **Grok** | `A|B` |\n| Pi | A\\|B |\n\n表后的说明');
  assert.equal(all(root, 'table').length, 1);
  assert.deepEqual(all(root, 'th').map(node => [node.textContent, node.attributes['data-align'], node.attributes.scope]), [
    ['Agent', 'left', 'col'], ['结论', 'right', 'col'],
  ]);
  assert.deepEqual(all(root, 'td').map(node => node.textContent), ['Grok', 'A|B', 'Pi', 'A|B']);
  assert.equal(all(root, 'p').at(-1)?.textContent, '表后的说明');
  assert.equal(all(render('| one | two |\n| --- | nope |'), 'table').length, 0);
});

test('raw HTML, images, scripts and unsafe URLs are only selectable text', () => {
  const input = '<img src="https://tracker.invalid/x" onerror="alert(1)">\n<script>window.hacked=true</script>\n![tracking](https://tracker.invalid/pixel)\n[run](javascript:alert(1))\n[data](data:text/html;base64,PHNjcmlwdD4=)';
  const root = render(input);
  assert.equal(root.textContent, input);
  const allowed = new Set(['div', 'p']);
  assert.ok(all(root).every(node => allowed.has(node.tagName)));
  assert.ok(all(root).every(node => Object.keys(node.attributes).length === 0));
  assert.equal(context.window.hacked, undefined);
});

test('ordinary web references show their complete address without navigation permissions', () => {
  const root = render('查看 [项目说明](https://example.com/noah?q=1#context) 和 https://example.com/plain。');
  assert.equal(root.textContent, '查看 项目说明 (https://example.com/noah?q=1#context) 和 https://example.com/plain。');
  assert.equal(all(root, 'a').length, 0);
  assert.equal(all(root).filter(node => node.className === 'rich-text-url')[0].textContent, 'https://example.com/noah?q=1#context');
  assert.ok(all(root).every(node => !('href' in node.attributes) && !('src' in node.attributes)));
});

test('oversized and deeply nested messages fall back to literal text without truncation', () => {
  const huge = '# **KEEP**\r\n' + 'x'.repeat(256 * 1024) + '\nEND';
  const root = render(huge);
  assert.equal(root.textContent, huge);
  assert.equal(root.children.length, 1);
  assert.equal((root.children[0] as Element).className, 'rich-text-plain');
  const manyLines = Array.from({ length: 4001 }, (_, i) => `${i}. data`).join('\n');
  assert.equal(render(manyLines).textContent, manyLines);
  const deep = '> '.repeat(1000) + 'END';
  assert.ok(render(deep).textContent.endsWith('END'));
});

test('adversarial unmatched delimiters have bounded parsing and retain the final message content', () => {
  const malformed = '[unclosed '.repeat(6000) + '\nLAST_SENTINEL';
  const root = render(malformed);
  assert.equal(root.textContent, malformed);
  const unclosedTicks = 'Inline: ' + '`'.repeat(64000) + 'FINAL_SENTINEL';
  assert.equal(render(unclosedTicks).textContent, unclosedTicks);
  const tooWide = Array(30).fill('value').join('|') + '\n' + Array(30).fill('---').join('|');
  assert.equal(render(tooWide).textContent, tooWide);
});
