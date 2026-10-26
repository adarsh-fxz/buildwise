import { button, el, icon } from './dom';
import { type FileRef, parseFileRef } from './fileRef';

export interface RichTextActions {
  copy(text: string): void;
  openFile(ref: FileRef): void;
}

const FENCE = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+/;

/** Paragraphs, lists, code blocks, `inline code` and **bold**, all built as text nodes. */
export function richText(text: string, actions: RichTextActions): HTMLElement {
  const body = el('div', { className: 'body' });
  let rest = 0;
  for (const match of text.matchAll(FENCE)) {
    body.append(...prose(text.slice(rest, match.index), actions));
    body.append(codeBlock(match[1] ?? '', (match[2] ?? '').replace(/\n$/, ''), actions));
    rest = match.index + match[0].length;
  }
  body.append(...prose(text.slice(rest), actions));
  return body;
}

function prose(text: string, actions: RichTextActions): HTMLElement[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((line) => LIST_ITEM.test(line))) {
        const ordered = /^\s*\d/.test(lines[0] ?? '');
        return el(
          ordered ? 'ol' : 'ul',
          {},
          lines.map((line) => el('li', {}, inline(line.replace(LIST_ITEM, ''), actions))),
        );
      }
      // Headings render as bold lines; a sidebar has no room for large type.
      return el('p', {}, inline(block.replace(/^#{1,6}\s+/gm, ''), actions));
    });
}

function inline(text: string, actions: RichTextActions): Node[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).flatMap((piece): Node[] => {
    if (piece === '') return [];
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
      const code = piece.slice(1, -1);
      const ref = parseFileRef(code);
      if (!ref) return [el('code', { text: code })];
      return [
        button([icon('file'), el('span', { text: code })], () => {
          actions.openFile(ref);
        }, { style: 'link', ariaLabel: `Open ${code}` }),
      ];
    }
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
      return [el('strong', { text: piece.slice(2, -2) })];
    }
    return [document.createTextNode(piece)];
  });
}

function codeBlock(language: string, code: string, actions: RichTextActions): HTMLElement {
  const label = el('span', { text: 'Copy' });
  const copy = button([icon('copy'), label], () => {
    actions.copy(code);
    label.textContent = 'Copied';
    window.setTimeout(() => {
      label.textContent = 'Copy';
    }, 1500);
  }, { style: 'icon', ariaLabel: 'Copy code' });

  return el('div', { className: 'code-block' }, [
    el('div', { className: 'code-head' }, [el('span', { className: 'code-language', text: language || 'code' }), copy]),
    el('pre', {}, [el('code', { text: code })]),
  ]);
}
