import { convertEmojiPlaceholders, parseMarkdown, walkAst, type Root } from 'chat';
import { splitMessage } from '@chat-adapter/whatsapp';

type Node = Root | Root['children'][number];
type Parent = Extract<Node, { children: unknown }>;

interface Syntax {
  text(value: string): string;
  code(value: string): string;
  block(value: string, language?: string | null): string;
  link(label: string, url: string): string;
  bold: string;
  italic: string;
  strike: string;
  bullet: string;
  number(value: number): string;
  quote: string;
  literal: RegExp;
}

const telegram: Syntax = {
  text: (value) => value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&'),
  code: (value) => `\`${value.replace(/[`\\]/g, '\\$&')}\``,
  block: (value, language) =>
    `\`\`\`${language && /^[\w#+.-]+$/.test(language) ? language : ''}\n${value.replace(/[`\\]/g, '\\$&')}\n\`\`\``,
  link: (label, url) => `[${label}](${url.replace(/[)\\]/g, '\\$&')})`,
  bold: '*',
  italic: '_',
  strike: '~',
  bullet: '•',
  number: (value) => `${value}\\.`,
  quote: '>',
  literal: /(?<![\w@:/.~-])[\w~./-]*[\w-]\.(?:md|py|sh|java|zip|mov)(?![\w-]|\.\w)/gi,
};

const whatsapp: Syntax = {
  text: (value) => value,
  code: (value) => `\`${value}\``,
  block: (value) => `\`\`\`\n${value}\n\`\`\``,
  link: (label, url) => `${label} (${url})`,
  bold: '*',
  italic: '_',
  strike: '~',
  bullet: '-',
  number: (value) => `${value}.`,
  quote: '> ',
  literal: /(?<![\p{L}\p{N}])([*_~])(?=\S)[^\n`]*?(?<=\S)\1(?![\p{L}\p{N}])/gu,
};

function plain(node: Node): string {
  if ('value' in node) return String(node.value);
  return 'children' in node ? node.children.map((child) => plain(child as Node)).join('') : '';
}

function prose(value: string, syntax: Syntax) {
  let result = '';
  let last = 0;
  for (const match of value.matchAll(syntax.literal)) {
    result += syntax.text(value.slice(last, match.index)) + syntax.code(match[0]);
    last = match.index + match[0].length;
  }
  return result + syntax.text(value.slice(last));
}

function render(root: Root, syntax: Syntax, source?: string, units?: string[]) {
  const inline = (nodes: Node[], open: ReadonlySet<string>) =>
    nodes.map((node) => phrase(node, open)).join('');

  const mark = (marker: string, node: Parent, open: ReadonlySet<string>) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (
      source !== undefined &&
      from !== undefined &&
      to !== undefined &&
      /[\p{L}\p{N}]/u.test(`${source[from - 1] ?? ''}${source[to] ?? ''}`)
    )
      return syntax.text(source.slice(from, to));
    const content = inline(node.children as Node[], new Set([...open, marker]));
    const core = content.trim();
    if (open.has(marker) || !core) return content;
    const start = content.indexOf(core);
    return `${content.slice(0, start)}${marker}${core}${marker}${content.slice(start + core.length)}`;
  };

  const phrase = (node: Node, open: ReadonlySet<string>): string => {
    switch (node.type) {
      case 'text':
        return open.has('link') ? syntax.text(node.value) : prose(node.value, syntax);
      case 'html':
        return syntax.text(node.value);
      case 'strong':
        return mark(syntax.bold, node, open);
      case 'emphasis':
        return mark(syntax.italic, node, open);
      case 'delete':
        return mark(syntax.strike, node, open);
      case 'inlineCode':
        return syntax.code(node.value);
      case 'break':
        return '\n';
      case 'link':
      case 'image': {
        const label = node.type === 'image' ? node.alt || 'Image' : plain(node);
        const rendered =
          node.type === 'image'
            ? syntax.text(label)
            : inline(node.children as Node[], new Set([...open, 'link']));
        if (
          !/^(?:https?|mailto|tel):/i.test(node.url) ||
          [label, `mailto:${label}`].includes(node.url)
        )
          return rendered;
        return syntax.link(rendered, node.url);
      }
      case 'footnoteReference':
        return syntax.text(`[${node.label ?? node.identifier}]`);
      default:
        return 'children' in node ? inline(node.children as Node[], open) : '';
    }
  };

  const none = new Set<string>();
  const blocks = (nodes: Node[], separator = '\n\n') =>
    nodes.map(block).filter(Boolean).join(separator);

  const block = (node: Node): string => {
    switch (node.type) {
      case 'paragraph':
        return inline(node.children, none);
      case 'heading':
        return mark(syntax.bold, node, none);
      case 'thematicBreak':
        return syntax.text('———');
      case 'code':
        return syntax.block(node.value, node.lang);
      case 'blockquote':
        return blocks(node.children)
          .split('\n')
          .map((line) =>
            `${syntax.quote}${line.startsWith(syntax.quote) ? line.slice(syntax.quote.length) : line}`.trimEnd(),
          )
          .join('\n');
      case 'list': {
        const items = node.children.map((item, index) => {
          const box = item.checked === true ? '☑' : item.checked === false ? '☐' : '';
          const marker = node.ordered
            ? `${syntax.number((node.start ?? 1) + index)}${box && ` ${box}`}`
            : box || syntax.bullet;
          const content = blocks(item.children, item.spread ? '\n\n' : '\n')
            .split('\n')
            .map((line, position) => (position && line ? `  ${line}` : line))
            .join('\n');
          return `${marker} ${content}`;
        });
        if (units && root.children[0] === node) for (const item of items) units.push(item);
        return items.join('\n');
      }
      case 'table': {
        const [head, ...rows] = node.children.map((row) => row.children);
        if (!head) return '';
        const labels = head.map((cell) => inline(cell.children, none).trim());
        if (!rows.length || labels.length < 2)
          return (rows.length ? rows.map((row) => row[0]) : head)
            .map((cell) => cell && inline(cell.children, none).trim())
            .filter(Boolean)
            .map((cell) => `${syntax.bullet} ${cell}`)
            .join('\n');
        const items = rows.map((row) =>
          [
            row[0] && mark(syntax.bold, row[0], none).trim(),
            ...row.slice(1).map((cell, index) => {
              const value = inline(cell.children, none).trim();
              const label = labels[index + 1];
              return value && `${syntax.bullet} ${label ? `${label}: ` : ''}${value}`;
            }),
          ]
            .filter(Boolean)
            .join('\n'),
        );
        if (units && root.children[0] === node) for (const item of items) units.push(item);
        return items.join('\n\n');
      }
      case 'definition':
        return '';
      case 'footnoteDefinition':
        return `${syntax.text(`[${node.label ?? node.identifier}]`)} ${blocks(node.children, '\n')}`;
      default:
        return 'children' in node ? blocks(node.children as Node[]) : phrase(node, none);
    }
  };

  return blocks(root.children).trim();
}

export function telegramText(markdown: string | Root) {
  return typeof markdown === 'string'
    ? render(parseMarkdown(markdown), telegram, markdown)
    : render(markdown, telegram);
}

export function whatsappText(markdown: string) {
  return render(parseMarkdown(markdown), whatsapp, markdown);
}

const slackEscape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const slack: Syntax = {
  ...whatsapp,
  text: slackEscape,
  code: (value) => `\`${slackEscape(value).replaceAll('`', "'")}\``,
  block: (value) => `\`\`\`\n${slackEscape(value).replaceAll('```', "'''")}\n\`\`\``,
  link: (label, url) =>
    `<${slackEscape(url).replaceAll('|', '%7C')}|${label.replaceAll('|', ' ')}>`,
};

export function slackText(markdown: string | Root) {
  return render(
    typeof markdown === 'string' ? parseMarkdown(markdown) : markdown,
    slack,
    typeof markdown === 'string' ? markdown : undefined,
  );
}

export function slackMessages(markdown: string) {
  const limit = 3000;
  const root = parseMarkdown(markdown);
  const parts: string[] = [];
  let current = '';
  const flush = () => {
    if (current) parts.push(current);
    current = '';
  };
  const pack = (text: string, separator: string) => {
    if (!text) return;
    if (current.length + separator.length + text.length > limit) flush();
    current += (current ? separator : '') + text;
  };
  const leaf = (text: string) => {
    flush();
    let code = '';
    let chunk = '';
    const close = () => (code === '```' ? '\n```' : code);
    const append = (token: string) => {
      const next = token === code ? '' : !code && /^`(?:``)?$/.test(token) ? token : code;
      const suffix = next === '```' ? '\n```' : next;
      if (chunk.length + token.length + suffix.length > limit) {
        parts.push(chunk + close());
        chunk = code === '```' ? '```\n' : code;
      }
      chunk += token;
      code = next;
    };
    for (const match of text.matchAll(/```|`|<[^>]*>|&(?:amp|lt|gt);|[\s\S]/gu)) {
      const token = match[0];
      if (token.length <= limit - 8) append(token);
      else {
        const divider = token.indexOf('|');
        const value = `${token.slice(divider + 1, -1)} (${token.slice(1, divider)})`;
        for (const point of value.matchAll(/```|`|&(?:amp|lt|gt);|[\s\S]/gu)) append(point[0]);
      }
    }
    if (chunk) parts.push(chunk + close());
  };
  for (const node of root.children) {
    const units: string[] = [];
    const text = render({ type: 'root', children: [node] }, slack, markdown, units);
    if (text.length <= limit) pack(text, '\n\n');
    else {
      flush();
      for (const unit of units.length ? units : [text]) {
        if (unit.length <= limit) pack(unit, node.type === 'list' ? '\n' : '\n\n');
        else leaf(unit);
      }
      flush();
    }
  }
  flush();
  return parts;
}
export function hasLiteralBlock(markdown: string, literal: string) {
  const root = parseMarkdown(markdown);
  const blocks = root.children.filter((node) => node.type === 'code');
  let count = 0;
  walkAst(root, (node) => {
    if (node.type === 'code') count++;
    return node;
  });
  return count === 1 && blocks.length === 1 && blocks[0]!.value === literal;
}

export function canDeliverWhatsAppLiteral(markdown: string, literal: string) {
  const formatted = whatsappText(markdown);
  return (
    hasLiteralBlock(markdown, literal) &&
    formatted.split('```').length === 3 &&
    convertEmojiPlaceholders(formatted, 'whatsapp') === formatted &&
    splitMessage(formatted).length === 1
  );
}
