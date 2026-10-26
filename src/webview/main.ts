import type { FromWebview, ToWebview, ViewState } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

// Kept outside the DOM so re-rendering doesn't lose what the learner is typing.
const drafts = { goal: '', question: '' };
let renderedEntries = 0;

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  render(event.data.state);
});
vscode.postMessage({ type: 'ready' });

const send = (message: FromWebview) => () => {
  vscode.postMessage(message);
};

function render(state: ViewState): void {
  const focused = document.activeElement?.id;
  root.replaceChildren(...(state.phase === 'idle' ? idleView(state) : sessionView(state)));
  if (focused) document.getElementById(focused)?.focus();

  const transcript = document.getElementById('transcript');
  if (transcript && state.transcript.length !== renderedEntries) {
    transcript.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  renderedEntries = state.transcript.length;
}

const ACTIVITY_TEXT = { thinking: 'Thinking…', checking: 'Running your checks…' } as const;

function idleView(state: ViewState): Node[] {
  if (state.model === undefined || state.needsFolder) return gettingStarted(state);

  const goal = el('textarea', { id: 'goal', rows: 3, placeholder: 'Add pagination to the posts page' });
  goal.value = drafts.goal;
  goal.addEventListener('input', () => (drafts.goal = goal.value));
  const start = () => {
    if (drafts.goal.trim() === '') return;
    vscode.postMessage({ type: 'start', goal: drafts.goal });
    drafts.goal = '';
  };
  goal.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) start();
  });

  return [
    el('section', { className: 'intro' }, [
      el('h2', { text: 'What do you want to build?' }),
      el('p', { text: 'Describe a feature in this project. BuildWise plans it with you, and you write the code.' }),
      goal,
      button(state.activity ? 'Planning…' : 'Start session', start, { primary: true, disabled: busy(state) }),
      el('p', { className: 'note' }, [
        document.createTextNode(`Using ${state.model}. `),
        button('Change', send({ type: 'setup' }), { link: true }),
      ]),
    ]),
    ...(state.transcript.length ? [transcriptView(state)] : []),
  ];
}

/** The steps before a first session: a model, then a project folder. */
function gettingStarted(state: ViewState): Node[] {
  const step = (done: boolean, title: string, text: string, action: HTMLButtonElement) =>
    el('li', { className: done ? 'passed' : 'active' }, [
      el('span', { className: 'marker', text: done ? '✓' : '›', ariaHidden: true }),
      el('div', {}, [el('div', { className: 'title', text: title }), ...(done ? [] : [el('div', { className: 'description', text }), action])]),
    ]);
  return [
    el('section', { className: 'intro' }, [
      el('h2', { text: 'Get started' }),
      el('p', { text: 'BuildWise is a mentor: it plans a feature with you and gives hints, and you write the code.' }),
    ]),
    el('ol', { className: 'checkpoints steps' }, [
      step(
        state.model !== undefined,
        'Choose an AI model',
        'BuildWise needs a model to plan and give hints. Google Gemini and Groq have free tiers.',
        button('Set up a model', send({ type: 'setup' }), { primary: true }),
      ),
      step(
        !state.needsFolder,
        'Open your project',
        'Open the folder of the project you want to build in.',
        button('Open Folder', send({ type: 'openFolder' }), { primary: state.model !== undefined }),
      ),
    ]),
  ];
}

function sessionView(state: ViewState): Node[] {
  const nodes: Node[] = [checkpointList(state), transcriptView(state)];
  if (state.activity) nodes.push(el('p', { className: 'status', text: ACTIVITY_TEXT[state.activity] }));
  nodes.push(state.phase === 'complete' ? completeActions() : sessionActions(state));
  return nodes;
}

function checkpointList(state: ViewState): HTMLElement {
  const markers = { passed: '✓', active: '›', pending: '·' } as const;
  return el(
    'ol',
    { className: 'checkpoints' },
    state.checkpoints.map((checkpoint) =>
      el('li', { className: checkpoint.status }, [
        el('span', { className: 'marker', text: markers[checkpoint.status], ariaHidden: true }),
        el('div', {}, [
          el('div', { className: 'title', text: checkpoint.title }),
          ...(checkpoint.status === 'active' ? [el('div', { className: 'description', text: checkpoint.description })] : []),
        ]),
      ]),
    ),
  );
}

function transcriptView(state: ViewState): HTMLElement {
  return el(
    'div',
    { id: 'transcript', className: 'transcript' },
    state.transcript.map((entry) =>
      el('article', { className: `entry from-${entry.from}${entry.label ? ' labeled' : ''}` }, [
        ...(entry.label ? [el('div', { className: 'label', text: entry.label })] : []),
        richText(entry.text),
      ]),
    ),
  );
}

function sessionActions(state: ViewState): HTMLElement {
  const building = state.phase === 'building';
  const actions: Node[] = [button('Check my work', send({ type: 'check' }), { primary: true, disabled: busy(state) })];

  if (building) {
    const nextHint = state.hintsUsed + 1;
    const hintLabel = nextHint > state.hintLevels ? 'No hints left' : `Hint ${String(nextHint)} of ${String(state.hintLevels)}`;
    actions.push(
      button(hintLabel, send({ type: 'hint' }), { disabled: busy(state) || nextHint > state.hintLevels }),
    );
    if (state.revealUnlocked) {
      actions.push(button('Reveal solution', send({ type: 'reveal' }), { disabled: busy(state) }));
    }
    if (state.canExplain) {
      actions.push(button('Explain the errors', send({ type: 'explain' }), { disabled: busy(state) }));
    }
  }

  const footer: Node[] = [el('div', { className: 'actions' }, actions)];
  if (building) footer.push(askForm(state));
  else footer.push(el('p', { className: 'note', text: 'Hints and questions are off for the independent check.' }));
  footer.push(button('End session', send({ type: 'end' }), { link: true, disabled: busy(state) }));
  return el('footer', {}, footer);
}

function askForm(state: ViewState): HTMLElement {
  const input = el('input', { id: 'question', type: 'text', placeholder: 'Ask a question' });
  input.value = drafts.question;
  input.disabled = busy(state);
  input.addEventListener('input', () => (drafts.question = input.value));
  const form = el('form', { className: 'ask' }, [input]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (drafts.question.trim() === '') return;
    vscode.postMessage({ type: 'ask', question: drafts.question });
    drafts.question = '';
  });
  return form;
}

function completeActions(): HTMLElement {
  return el('footer', {}, [button('New session', send({ type: 'new' }), { primary: true })]);
}

function busy(state: ViewState): boolean {
  return state.activity !== undefined;
}

/** Paragraphs, ``` code blocks and `inline code`, all as text nodes. */
function richText(text: string): HTMLElement {
  const body = el('div', { className: 'body' });
  text.split(/```[^\n]*\n?/).forEach((part, index) => {
    if (index % 2 === 1) {
      body.append(el('pre', {}, [el('code', { text: part.replace(/\n$/, '') })]));
      return;
    }
    for (const raw of part.split(/\n{2,}/)) {
      const paragraph = raw.trim();
      if (paragraph === '') continue;
      const p = el('p');
      paragraph.split(/`([^`\n]+)`/).forEach((piece, i) => {
        p.append(i % 2 === 1 ? el('code', { text: piece }) : document.createTextNode(piece));
      });
      body.append(p);
    }
  });
  return body;
}

function button(
  label: string,
  onClick: () => void,
  { primary = false, link = false, disabled = false } = {},
): HTMLButtonElement {
  const node = el('button', { type: 'button', text: label, className: primary ? 'primary' : link ? 'link' : 'secondary' });
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}

interface Props {
  id?: string;
  className?: string;
  text?: string;
  type?: string;
  placeholder?: string;
  rows?: number;
  ariaHidden?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.id) node.id = props.id;
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.type) node.setAttribute('type', props.type);
  if (props.placeholder) node.setAttribute('placeholder', props.placeholder);
  if (props.rows) node.setAttribute('rows', String(props.rows));
  if (props.ariaHidden) node.setAttribute('aria-hidden', 'true');
  node.append(...children);
  return node;
}
