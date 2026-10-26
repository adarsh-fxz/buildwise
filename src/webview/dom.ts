// Small DOM helpers. Text always goes in through textContent, never
// innerHTML, because most of it comes from the model.

export interface Props {
  id?: string;
  className?: string;
  text?: string;
  title?: string;
  type?: string;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
  ariaHidden?: boolean;
  htmlFor?: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.id) node.id = props.id;
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.type) node.setAttribute('type', props.type);
  if (props.placeholder) node.setAttribute('placeholder', props.placeholder);
  if (props.rows) node.setAttribute('rows', String(props.rows));
  if (props.ariaLabel) node.setAttribute('aria-label', props.ariaLabel);
  if (props.ariaHidden) node.setAttribute('aria-hidden', 'true');
  if (props.htmlFor) node.setAttribute('for', props.htmlFor);
  node.append(...children);
  return node;
}

export type ButtonStyle = 'primary' | 'secondary' | 'link' | 'chip' | 'icon' | 'problem';

export function button(
  content: string | Node[],
  onClick: () => void,
  { style = 'secondary', disabled = false, ariaLabel }: { style?: ButtonStyle; disabled?: boolean; ariaLabel?: string } = {},
): HTMLButtonElement {
  const node = el('button', { type: 'button', className: `button ${style}`, ...(ariaLabel && { ariaLabel }) });
  node.append(...(typeof content === 'string' ? [document.createTextNode(content)] : content));
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}

// 16px icons on one 1.5px stroke, drawn in currentColor so they follow the theme.
const ICONS = {
  check: ['M3.5 8.5l3 3 6-7'],
  lightbulb: ['M6 12.5h4', 'M6.5 14.5h3', 'M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5z'],
  error: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M5.75 5.75l4.5 4.5', 'M10.25 5.75l-4.5 4.5'],
  info: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M8 7.5v4', 'M8 5v.01'],
  copy: ['M6.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z', 'M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2'],
  book: ['M2.5 3.5a1 1 0 0 1 1-1H13v10H3.5a1 1 0 0 0-1 1z', 'M2.5 13.5a1 1 0 0 0 1 1H13'],
  chat: ['M2.5 3h11v7.5h-6L4.5 13.5V10.5h-2z'],
  target: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M8 7.75v.5'],
  list: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.75 4h.01', 'M2.75 8h.01', 'M2.75 12h.01'],
  file: ['M4 1.5h5l3.5 3.5v9.5h-8.5z', 'M9 1.5V5h3.5'],
  trophy: ['M5 2h6v4a3 3 0 0 1-6 0z', 'M5 3H2.5v1a2.5 2.5 0 0 0 2.5 2.5', 'M11 3h2.5v1A2.5 2.5 0 0 1 11 6.5', 'M8 9v3', 'M5.5 14h5'],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${className}`.trim());
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
