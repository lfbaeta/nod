import { parseMarkdown, type Root } from 'chat';
import type { KnownBlock, RichTextText, RichTextLink, TableBlock } from '@slack/types';

type Node = Root | Root['children'][number];
type Style = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
type Span = {
  text: string;
  style?: Style;
  url?: string;
  from?: number;
  end: number;
  raw?: boolean;
};
type Frame = {
  type: 'section' | 'quote' | 'code' | 'list';
  indent?: number;
  number?: number;
  language?: string;
};
export type SlackUnit = { block: KnownBlock; text: string; from: number; end: number };
export type SlackPart = { blocks?: KnownBlock[]; text: string; from: number; end: number };
export type SlackPlan = { units: SlackUnit[]; parts: SlackPart[]; plain: SlackPart[] };

const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const children = (node: Node) => ('children' in node ? (node.children as Node[]) : []);
const start = (node: Node) => node.position!.start.offset!;
const end = (node: Node) => node.position!.end.offset!;

export function validateSlackSource(source: string) {
  if (source.includes('\0')) throw new Error('Slack rendering failed: NUL is not representable.');
  for (const point of source)
    if (point.length === 1 && /[\uD800-\uDFFF]/.test(point))
      throw new Error('Slack rendering failed: ill-formed UTF16.');
}

function cut(value: string, limit: number) {
  let offset = 0;
  let size = 0;
  let word = 0;
  let line = 0;
  for (const point of value) {
    const length = escape(point).length;
    if (size + length > limit) break;
    offset += point.length;
    size += length;
    if (/\s/u.test(point)) word = offset;
    if (point === '\n') line = offset;
  }
  return offset === value.length ? offset : line || word || offset;
}

function literal(source: string): SlackPart[] {
  const parts: SlackPart[] = [];
  let from = 0;
  while (from < source.length) {
    const to = from + cut(source.slice(from, from + 3002), 3000);
    parts.push({ text: escape(source.slice(from, to)), from, end: to });
    from = to;
  }
  return parts;
}

const linkable = (url: string) =>
  /^(?:https?:\/\/|mailto:|tel:)[^\s()<>"`\\{}|^]+$/.test(url) &&
  !/&(?:#|[a-z][a-z0-9]*;)/i.test(url);

function exact(node: Node, source: string) {
  const parents = new Set(['paragraph', 'heading', 'tableCell', 'strong', 'emphasis', 'delete']);
  let count = 0;
  const walk = (node: Node, from: number, to: number, depth: number): boolean => {
    if (++count > 20_000 || depth > 64) return false;
    const a = node.position?.start.offset;
    const b = node.position?.end.offset;
    if (
      a === undefined ||
      b === undefined ||
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < from ||
      b > to ||
      a > b
    )
      return false;
    const raw = source.slice(a, b);
    if (node.type === 'text') return node.value === raw;
    if (node.type === 'inlineCode') {
      const match = /^(`+)([^\n]*?)\1$/.exec(raw);
      return Boolean(match && match[2] === node.value);
    }
    if (node.type === 'image') return !node.title && raw === `![${node.alt ?? ''}](${node.url})`;
    if (node.type === 'link') {
      if (!raw.startsWith('['))
        return (
          !node.title &&
          node.children.length === 1 &&
          node.children[0].type === 'text' &&
          node.children[0].value === raw &&
          /^\S+$/.test(raw)
        );
      if (
        !linkable(node.url) ||
        node.title ||
        node.children.some((child) => child.type !== 'text') ||
        !raw.endsWith(`](${node.url})`)
      )
        return false;
    } else if (node.type === 'break') return /^ {2,}\n$/.test(raw);
    else if (!parents.has(node.type)) return false;
    let previous = a;
    for (const child of children(node)) {
      if ((child.position?.start.offset ?? -1) < previous || !walk(child, a, b, depth + 1))
        return false;
      previous = end(child);
    }
    return true;
  };
  const a = node.position?.start.offset;
  const b = node.position?.end.offset;
  return a !== undefined && b !== undefined && walk(node, a, b, 0);
}

function pack(units: SlackUnit[], native: boolean) {
  const parts: SlackPart[] = [];
  let current: SlackPart | undefined;
  for (const unit of units) {
    const next: SlackPart = {
      from: current?.from ?? unit.from,
      end: unit.end,
      text: (current?.text ?? '') + unit.text,
      ...(native ? { blocks: [...(current?.blocks ?? []), unit.block] } : {}),
    };
    if (
      current &&
      (next.text.length > 3000 ||
        (next.blocks?.length ?? 0) > 40 ||
        bytes(next) > 30_000 ||
        (native &&
          (unit.block.type === 'table' || current.blocks?.some((block) => block.type === 'table'))))
    ) {
      parts.push(current);
      current = undefined;
    }
    current = current
      ? next
      : {
          from: unit.from,
          end: unit.end,
          text: unit.text,
          ...(native ? { blocks: [unit.block] } : {}),
        };
  }
  if (current) parts.push(current);
  return parts;
}

export function slackPlan(source: string, metadata = false): SlackPlan {
  validateSlackSource(source);
  const fallback = (): SlackPlan => {
    const parts = literal(source);
    return { units: [], parts, plain: parts };
  };
  if (
    !source ||
    metadata ||
    source.length > 100_000 ||
    /[\r\uFEFF]|<[!@#]|&(?:lt|gt|#0*6[02]|#x0*3[ce]);?/iu.test(source)
  )
    return fallback();
  try {
    const root = parseMarkdown(source);
    if (root.position?.start.offset !== 0 || root.position.end.offset !== source.length)
      return fallback();
    const units: SlackUnit[] = [];
    let covered = 0;
    const framed = (node: Node, from: number, to: number) => {
      const a = node.position?.start.offset;
      const b = node.position?.end.offset;
      if (
        a === undefined ||
        b === undefined ||
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        a < from ||
        b > to ||
        a > b
      )
        throw new Error('native_shape');
    };
    const inline = (node: Node, style: Style = {}): Span[] => {
      if (node.type === 'text')
        return [{ text: node.value, style, from: start(node), end: end(node) }];
      if (node.type === 'inlineCode') {
        const raw = source.slice(start(node), end(node));
        return [
          {
            text: node.value,
            style: { ...style, code: true },
            from: start(node) + /^`+/.exec(raw)![0].length,
            end: end(node),
          },
        ];
      }
      if (node.type === 'break') return [{ text: '\n', end: end(node) }];
      if (['strong', 'emphasis', 'delete'].includes(node.type)) {
        if (/[\p{L}\p{N}]/u.test(`${source[start(node) - 1] ?? ''}${source[end(node)] ?? ''}`))
          return [
            {
              text: source.slice(start(node), end(node)),
              style,
              from: start(node),
              end: end(node),
            },
          ];
        style = {
          ...style,
          [node.type === 'strong' ? 'bold' : node.type === 'emphasis' ? 'italic' : 'strike']: true,
        };
      }
      if (node.type === 'image' || (node.type === 'link' && !source.startsWith('[', start(node))))
        return [
          { text: source.slice(start(node), end(node)), style, from: start(node), end: end(node) },
        ];
      if (node.type === 'link')
        return [
          {
            text: children(node)
              .flatMap((n) => inline(n))
              .map((s) => s.text)
              .join(''),
            url: node.url,
            style,
            end: end(node),
          },
        ];
      return children(node).flatMap((n) => inline(n, style));
    };
    const leaf = (node: Node, style: Style = {}, quoted = false): Span[] => {
      if (exact(node, source)) return inline(node, style);
      const parts = children(node);
      if (!parts.length) return [];
      const positioned = parts.every(
        (child) =>
          Number.isInteger(child.position?.start.offset) &&
          Number.isInteger(child.position?.end.offset),
      );
      if (!positioned && node.type !== 'paragraph') throw new Error('native_shape');
      const from = positioned ? start(parts[0]) : start(node);
      const to = positioned ? end(parts[parts.length - 1]) : end(node);
      const text = source.slice(from, to);
      if (quoted && text.includes('\n')) throw new Error('native_shape');
      return [{ text, style, from, end: to, raw: true }];
    };
    const emit = (
      spans: Span[],
      frame: Frame,
      finish: number,
      separator: string,
      atomic = false,
    ) => {
      let pending: Span[] = [];
      let length = 0;
      let plain = separator;
      let first = true;
      const flush = () => {
        if (!pending.length) return;
        const elements = pending.map((span): RichTextText | RichTextLink =>
          span.url
            ? {
                type: 'link',
                url: span.url,
                text: span.text,
                ...(span.style ? { style: span.style } : {}),
              }
            : { type: 'text', text: span.text, ...(span.style ? { style: span.style } : {}) },
        );
        const section = { type: 'rich_text_section' as const, elements };
        const element =
          frame.type === 'list'
            ? {
                type: 'rich_text_list' as const,
                style: frame.number === undefined ? ('bullet' as const) : ('ordered' as const),
                indent: frame.indent ?? 0,
                ...(frame.number === undefined ? {} : { offset: frame.number - 1 }),
                elements: [section],
              }
            : frame.type === 'quote'
              ? { type: 'rich_text_quote' as const, elements }
              : frame.type === 'code'
                ? {
                    type: 'rich_text_preformatted' as const,
                    elements,
                    ...(frame.language ? { language: frame.language } : {}),
                  }
                : section;
        const block: KnownBlock = { type: 'rich_text', elements: [element] };
        const next = atomic ? covered : Math.max(covered, ...pending.map((s) => s.end));
        const unit = { block, text: escape(plain), from: covered, end: next };
        if (unit.text.length > 3000 || bytes(unit) > 18_000) throw new Error('native_budget');
        units.push(unit);
        covered = next;
        pending = [];
        length = 0;
        plain = '';
        first = false;
      };
      if (frame.type === 'list')
        plain += `${'  '.repeat(frame.indent ?? 0)}${frame.number === undefined ? '-' : `${frame.number}.`} `;
      if (frame.type === 'code' && frame.language) plain += `[${frame.language}]\n`;
      for (const span of spans) {
        if (!span.text) continue;
        if (span.url) {
          const projection = `${span.text} (${span.url})`;
          if (span.text.length > 2800 || escape(projection).length > 2800 || bytes(span) > 12_000)
            throw new Error('native_budget');
          if (
            length + span.text.length > 2800 ||
            pending.length >= 200 ||
            escape(plain + projection).length > 2900
          )
            flush();
          pending.push(span);
          plain += projection;
          length += span.text.length;
          continue;
        }
        let offset = 0;
        while (offset < span.text.length) {
          if (length >= 2800 || pending.length >= 200 || escape(plain).length >= 2900) flush();
          const size = cut(
            span.text.slice(offset, offset + 2802),
            Math.min(2800 - length, 2900 - escape(plain).length),
          );
          if (!size) {
            flush();
            continue;
          }
          const value = span.text.slice(offset, offset + size);
          const complete = offset + size === span.text.length;
          pending.push({
            ...span,
            text: value,
            end: complete
              ? span.end
              : span.from === undefined
                ? covered
                : span.from + offset + size,
          });
          length += value.length;
          plain += value;
          offset += size;
        }
      }
      flush();
      if (first) throw new Error('empty_native');
      units[units.length - 1].end = Math.max(covered, finish);
      covered = units[units.length - 1].end;
    };
    const block = (node: Node, indent = 0, separator = '\n\n') => {
      if (['blockquote', 'list', 'table'].includes(node.type))
        for (const child of children(node)) framed(child, start(node), end(node));
      if (node.type === 'heading') {
        const spans = leaf(node);
        const value = spans.map((s) => s.text).join('');
        if (
          value &&
          value.length <= 150 &&
          !/[&<>]/.test(value) &&
          spans.every((s) => !s.url && !s.raw && !Object.values(s.style ?? {}).some(Boolean))
        ) {
          units.push({
            block: { type: 'header', text: { type: 'plain_text', text: value, emoji: false } },
            text: escape((units.length ? separator : '') + value),
            from: covered,
            end: end(node),
          });
          covered = end(node);
        } else
          emit(
            leaf(node, { bold: true }),
            { type: 'section' },
            end(node),
            units.length ? separator : '',
          );
      } else if (node.type === 'paragraph')
        emit(leaf(node), { type: 'section' }, end(node), units.length ? separator : '');
      else if (node.type === 'code') {
        const lineStart = source.lastIndexOf('\n', start(node) - 1) + 1;
        const pad = start(node) - lineStart;
        if (/[^ ]/.test(source.slice(lineStart, start(node)))) throw new Error('native_shape');
        const lines = source.slice(start(node), end(node)).split('\n');
        const raw = lines
          .map((line, index) =>
            index ? line.slice(Math.min(pad, /^ */.exec(line)![0].length)) : line,
          )
          .join('\n');
        const match = /^(`{3,}|~{3,})([\w#+.-]*)\n([\s\S]*?)\n\1$/.exec(raw);
        if (
          !match ||
          !node.value ||
          match[3] !== node.value ||
          (node.lang ?? '').length > 80 ||
          (node.lang ?? '') !== match[2] ||
          node.meta
        )
          throw new Error('native_shape');
        const bodyFrom = source.indexOf('\n', start(node)) + 1;
        emit(
          [
            pad
              ? { text: node.value, end: end(node) }
              : { text: node.value, from: bodyFrom, end: bodyFrom + node.value.length },
          ],
          { type: 'code', ...(node.lang ? { language: node.lang } : {}) },
          end(node),
          units.length ? separator : '',
        );
      } else if (node.type === 'blockquote') {
        if (node.children.some((child) => child.type !== 'paragraph'))
          throw new Error('native_shape');
        for (const [index, child] of node.children.entries())
          emit(
            leaf(child, {}, true),
            { type: 'quote' },
            index === node.children.length - 1 ? end(node) : end(child),
            units.length ? (index ? '\n' : separator) : '',
          );
      } else if (node.type === 'list') {
        if (indent > 8) throw new Error('native_indent');
        if (
          node.ordered &&
          ((node.start ?? 1) < 1 ||
            !node.children.every(
              (item, index) =>
                /^(\d+)[.)] /.exec(source.slice(start(item), end(item)))?.[1] ===
                String((node.start ?? 1) + index),
            ))
        )
          throw new Error('native_shape');
        for (const [index, item] of node.children.entries()) {
          if (
            item.children[0]?.type !== 'paragraph' ||
            item.children.slice(1).some((child) => child.type !== 'list' && child.type !== 'code')
          )
            throw new Error('native_shape');
          for (const child of item.children) framed(child, start(item), end(item));
          const number = node.ordered ? (node.start ?? 1) + index : undefined;
          for (const child of item.children) {
            if (child.type === 'paragraph') {
              const spans = leaf(child);
              if (item.checked !== null && item.checked !== undefined)
                spans.unshift({ text: item.checked ? '[x] ' : '[ ] ', end: start(child) });
              emit(spans, { type: 'list', indent, number }, end(child), units.length ? '\n' : '');
            } else block(child, indent + 1, '\n');
          }
          units[units.length - 1].end = end(item);
          covered = end(item);
        }
      } else if (node.type === 'table') {
        for (const row of node.children)
          for (const cell of row.children) framed(cell, start(row), end(row));
        const [head, ...rows] = node.children;
        const labels = head.children.map((cell) =>
          leaf(cell)
            .map((s) => s.text)
            .join(''),
        );
        if (
          head.children.length <= 20 &&
          head.children.length > 0 &&
          rows.every((row) => row.children.length === head.children.length) &&
          node.children.every((row) =>
            row.children.every((cell) => exact(cell, source) && inline(cell).some((s) => s.text)),
          )
        ) {
          const cell = (node: Node, bold = false): TableBlock['rows'][number][number] => ({
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: inline(node, bold ? { bold: true } : {}).map((span) =>
                  span.url
                    ? { type: 'link', url: span.url, text: span.text, style: span.style }
                    : { type: 'text', text: span.text, style: span.style },
                ),
              },
            ],
          });
          const header = head.children.map((node) => cell(node, true));
          let pending: TableBlock['rows'] = [header];
          const headerText = head.children
            .map((node) =>
              inline(node)
                .map((span) => (span.url ? `${span.text} (${span.url})` : span.text))
                .join(''),
            )
            .join(' | ');
          let plain = headerText;
          let finish = end(head);
          const flush = () => {
            const unit: SlackUnit = {
              block: {
                type: 'table',
                rows: pending,
                column_settings: head.children.map((_, index) => ({
                  is_wrapped: true,
                  align: node.align?.[index] ?? 'left',
                })),
              },
              text: escape((units.length ? '\n\n' : '') + plain),
              from: covered,
              end: finish,
            };
            if (unit.text.length > 3000 || bytes(unit) > 18_000) throw new Error('native_budget');
            units.push(unit);
            covered = finish;
            pending = [header];
            plain = headerText;
          };
          for (const row of rows) {
            const rendered = row.children.map((node) => cell(node));
            const text = row.children
              .map(
                (node, index) =>
                  `${labels[index]}: ${inline(node)
                    .map((span) => (span.url ? `${span.text} (${span.url})` : span.text))
                    .join('')}`,
              )
              .join('\n');
            if (
              pending.length > 1 &&
              (pending.length >= 100 ||
                escape(plain + '\n\n' + text).length > 2900 ||
                bytes([...pending, rendered]) > 15_000)
            )
              flush();
            pending.push(rendered);
            plain += '\n\n' + text;
            finish = end(row);
          }
          finish = end(node);
          flush();
          return;
        }
        if (!rows.length) {
          emit(
            head.children.flatMap((cell, index) => [
              ...(index ? [{ text: '\n', end: start(cell) }] : []),
              ...leaf(cell),
            ]),
            { type: 'section' },
            end(head),
            units.length ? '\n\n' : '',
          );
        }
        for (const row of rows) {
          const spans: Span[] = [];
          for (let index = 0; index < Math.max(labels.length, row.children.length); index++) {
            spans.push({
              text: `${index ? '\n' : ''}${labels[index] ?? `Column ${index + 1}`}: `,
              end: start(row),
            });
            if (row.children[index])
              spans.push(...leaf(row.children[index], index ? {} : { bold: true }));
          }
          emit(spans, { type: 'section' }, end(row), units.length ? '\n\n' : '', true);
        }
      } else if (
        node.type === 'thematicBreak' &&
        /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(source.slice(start(node), end(node)))
      )
        emit(
          [{ text: '---', end: end(node) }],
          { type: 'section' },
          end(node),
          units.length ? separator : '',
        );
      else throw new Error('native_shape');
    };
    for (const node of root.children) {
      framed(node, covered, source.length);
      const count = units.length;
      const from = covered;
      try {
        block(node);
      } catch {
        units.length = count;
        covered = from;
        emit(
          [{ text: source.slice(start(node), end(node)), from: start(node), end: end(node) }],
          { type: 'section' },
          end(node),
          units.length ? '\n\n' : '',
        );
      }
    }
    if (!units.length) return fallback();
    units[units.length - 1].end = source.length;
    const parts = pack(units, true);
    const plain = pack(units, false);
    return { units, parts, plain };
  } catch {
    return fallback();
  }
}

export function slackStreamParts(plan: SlackPlan) {
  if (!plan.units.length || plan.units.some((unit) => unit.block.type === 'table')) return;
  const parts: Array<{
    from: number;
    end: number;
    calls: Array<{ blocks: KnownBlock[]; end: number }>;
  }> = [];
  let part: (typeof parts)[number] | undefined;
  let projected = 0;
  let count = 0;
  for (let index = 0; index < plan.units.length;) {
    const group: SlackUnit[] = [];
    let size = 0;
    do {
      const unit = plan.units[index++];
      group.push(unit);
      size += unit.text.length;
    } while (
      index < plan.units.length &&
      group[group.length - 1].end === group[group.length - 1].from
    );
    if (group.length > 40 || size > 9000) return;
    if (!part || count + group.length > 40 || projected + size > 9000) {
      part = { from: group[0].from, end: group[group.length - 1].end, calls: [] };
      parts.push(part);
      count = 0;
      projected = 0;
    }
    for (const unit of group) part.calls.push({ blocks: [unit.block], end: unit.end });
    part.end = group[group.length - 1].end;
    projected += size;
    count += group.length;
  }
  return parts;
}
