import { button, el, icon } from './dom';
import type { FromWebview, ModelChoice, ToWebview } from './protocol';

// The input box at the bottom of the panel, with the provider, model and
// effort menus under it, as in chat apps.

type MenuName = 'provider' | 'model' | 'effort';
type ModelList = Extract<ToWebview, { type: 'models' }>;

const EFFORTS: Record<string, { readonly label: string; readonly detail: string }> = {
  auto: { label: 'Auto', detail: 'BuildWise chooses for each request' },
  none: { label: 'None', detail: 'No thinking' },
  minimal: { label: 'Minimal', detail: 'The least thinking the model allows' },
  low: { label: 'Low', detail: 'Quick answers' },
  medium: { label: 'Medium', detail: 'Thinks longer, for better plans' },
  high: { label: 'High', detail: 'Slowest; free tiers may time out' },
};
const MAX_GROW_PX = 160;
const FILTER_FROM = 7;

// Kept outside the DOM, which is rebuilt on every render.
let openMenu: MenuName | undefined;
let modelList: ModelList | undefined;
let filter = '';
let post: (message: FromWebview) => void = () => undefined;
let rerender: () => void = () => undefined;

export function initComposer(send: (message: FromWebview) => void, render: () => void): void {
  post = send;
  rerender = render;
  document.addEventListener('mousedown', (event) => {
    const target = event.target as Element | null;
    if (openMenu && !target?.closest('.menu, .picker')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !openMenu) return;
    const picker = `picker-${openMenu}`;
    close();
    document.getElementById(picker)?.focus();
  });
}

export function receiveModels(list: ModelList): void {
  modelList = list;
  if (openMenu === 'model') rerender();
}

export interface ComposerOptions {
  readonly id: string;
  readonly placeholder: string;
  /** Names the input and the send button for screen readers, such as "Ask a question". */
  readonly label: string;
  readonly value: string;
  readonly inputDisabled: boolean;
  readonly busy: boolean;
  readonly choice: ModelChoice | undefined;
  readonly onInput: (text: string) => void;
  readonly onSend: () => void;
}

export function composer(options: ComposerOptions): HTMLElement {
  const input = el('textarea', { id: options.id, rows: 1, placeholder: options.placeholder, ariaLabel: options.label });
  input.value = options.value;
  input.disabled = options.inputDisabled;
  const canSend = () => !options.busy && !options.inputDisabled && input.value.trim() !== '';

  const send = button([icon('arrowUp')], options.onSend, { style: 'send', ariaLabel: options.label, disabled: !canSend() });
  input.addEventListener('input', () => {
    options.onInput(input.value);
    send.disabled = !canSend();
    grow(input);
  });
  // Enter sends and Shift+Enter starts a new line, as in chat apps.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (canSend()) options.onSend();
  });
  requestAnimationFrame(() => {
    grow(input);
  });

  const { choice } = options;
  const bar = el('div', { className: 'composer-bar' }, [
    ...(choice ? pickers(choice) : []),
    el('span', { className: 'spacer' }),
    send,
  ]);
  const box = el('div', { className: 'composer' }, [input, bar, ...(openMenu && choice ? [menu(openMenu, choice)] : [])]);
  // Clicking the empty part of the box goes to the input, as in a text field.
  box.addEventListener('mousedown', (event) => {
    if (event.target === box || event.target === bar) {
      event.preventDefault();
      input.focus();
    }
  });
  return box;
}

function pickers(choice: ModelChoice): HTMLElement[] {
  const provider = choice.providers.find((p) => p.id === choice.provider);
  const effort = EFFORTS[choice.effort]?.label ?? choice.effort;
  return [
    picker('provider', undefined, provider?.label ?? choice.provider, `Provider: ${provider?.label ?? choice.provider}`),
    picker('model', undefined, choice.model, `Model: ${choice.model}`),
    picker('effort', 'gauge', effort, `Reasoning effort: ${effort}`),
  ];
}

function picker(name: MenuName, glyph: 'gauge' | undefined, text: string, label: string): HTMLButtonElement {
  const content = [...(glyph ? [icon(glyph)] : []), el('span', { className: 'picker-text', text }), icon('chevron', 'chevron')];
  const node = button(content, () => {
    toggle(name);
  }, { style: 'picker', ariaLabel: label });
  node.id = `picker-${name}`;
  node.title = label;
  node.classList.add(name);
  node.setAttribute('aria-haspopup', 'menu');
  node.setAttribute('aria-expanded', String(openMenu === name));
  return node;
}

function toggle(name: MenuName): void {
  openMenu = openMenu === name ? undefined : name;
  filter = '';
  if (openMenu === 'model' && (!modelList || modelList.error)) {
    modelList = undefined;
    post({ type: 'listModels' });
  }
  rerender();
}

function close(): void {
  openMenu = undefined;
  rerender();
}

function choose(message: FromWebview): void {
  post(message);
  close();
}

function menu(name: MenuName, choice: ModelChoice): HTMLElement {
  const node = el('div', { className: 'menu', ariaLabel: { provider: 'Providers', model: 'Models', effort: 'Reasoning effort' }[name] });
  node.setAttribute('role', 'menu');
  if (name === 'provider') node.append(...providerItems(choice));
  else if (name === 'effort') node.append(...effortItems(choice));
  else node.append(...modelMenu(choice));
  return node;
}

function providerItems(choice: ModelChoice): Node[] {
  return [
    ...choice.providers.map((provider) =>
      item(provider.label, `${provider.free ? 'Free' : 'Paid'}${provider.ready ? '' : ' · needs setup'}`, provider.id === choice.provider, () => {
        choose({ type: 'chooseProvider', provider: provider.id });
      }),
    ),
    el('div', { className: 'menu-separator', ariaHidden: true }),
    item('Set up a provider or API key…', undefined, undefined, () => {
      choose({ type: 'setup' });
    }),
  ];
}

function effortItems(choice: ModelChoice): Node[] {
  return choice.efforts.map((effort) => {
    const text = EFFORTS[effort] ?? { label: effort, detail: '' };
    return item(text.label, text.detail, effort === choice.effort, () => {
      choose({ type: 'chooseEffort', effort });
    });
  });
}

function modelMenu(choice: ModelChoice): Node[] {
  // A list for another provider is stale; a new one is on its way.
  if (!modelList || modelList.provider !== choice.provider) {
    const loading = el('p', { className: 'menu-note', text: 'Getting the model list…' });
    loading.setAttribute('role', 'status');
    return [loading];
  }
  if (modelList.error) {
    return [
      el('p', { className: 'menu-note', text: `Could not get the model list: ${modelList.error}` }),
      item('Try again', undefined, undefined, () => {
        modelList = undefined;
        post({ type: 'listModels' });
        rerender();
      }),
    ];
  }

  const models = modelList.models;
  const list = el('div', { className: 'menu-list' });
  // Filters in place rather than re-rendering, so typing keeps its caret.
  const fill = () => {
    const query = filter.trim().toLowerCase();
    const shown = models.filter((model) => model.toLowerCase().includes(query));
    const custom = query !== '' && !models.some((model) => model.toLowerCase() === query);
    list.replaceChildren(
      ...shown.map((model) =>
        item(model, undefined, model === choice.model, () => {
          choose({ type: 'chooseModel', model });
        }),
      ),
      ...(custom
        ? [
            item(`Use "${filter.trim()}"`, 'A model name the list does not show', undefined, () => {
              choose({ type: 'chooseModel', model: filter.trim() });
            }),
          ]
        : []),
      ...(shown.length === 0 && !custom ? [el('p', { className: 'menu-note', text: 'No models listed.' })] : []),
    );
  };
  fill();

  if (models.length < FILTER_FROM) return [list];
  const search = el('input', { id: 'model-filter', type: 'text', placeholder: 'Filter, or type a model name', ariaLabel: 'Filter models' });
  search.value = filter;
  search.addEventListener('input', () => {
    filter = search.value;
    fill();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    list.querySelector<HTMLButtonElement>('.menu-item')?.click();
  });
  requestAnimationFrame(() => {
    search.focus();
  });
  return [search, list];
}

function item(text: string, detail: string | undefined, checked: boolean | undefined, onClick: () => void): HTMLButtonElement {
  const node = el('button', { type: 'button', className: 'menu-item' }, [
    checked ? icon('check', 'menu-check') : el('span', { ariaHidden: true }),
    el('span', { className: 'menu-label', text }),
    ...(detail ? [el('span', { className: 'menu-detail', text: detail })] : []),
  ]);
  node.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
  if (checked !== undefined) node.setAttribute('aria-checked', String(checked));
  node.addEventListener('click', onClick);
  return node;
}

function grow(input: HTMLTextAreaElement): void {
  input.style.setProperty('height', 'auto');
  input.style.setProperty('height', `${String(Math.min(input.scrollHeight, MAX_GROW_PX))}px`);
}
