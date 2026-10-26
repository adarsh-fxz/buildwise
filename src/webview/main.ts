import { button, el, icon, type IconName } from './dom';
import type { FileRef } from './fileRef';
import { nextStep } from './guide';
import type { FromWebview, ToWebview, ViewState } from './protocol';
import { richText } from './richText';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

type Entry = ViewState['transcript'][number];

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

const SAVE_KEYS = navigator.userAgent.includes('Mac') ? '⌘S' : 'Ctrl+S';
const START_KEYS = navigator.userAgent.includes('Mac') ? '⌘Enter' : 'Ctrl+Enter';
const MAX_LISTED_PROBLEMS = 5;
const EXAMPLE_GOALS = [
  'Add a function called greet that takes a name and returns "Hello, <name>!"',
  'Add a function isEven that returns true when a number is even',
  'Add a function that returns the largest number in a list, and print the result',
];

// Kept outside the DOM so re-rendering doesn't lose what the learner is typing.
const drafts = { goal: '', question: '' };
let renderedEntries = 0;
let current: ViewState | undefined;

// Counts the seconds of the current wait so slow can be told apart from stuck.
const ACTIVITY_TEXT = { thinking: 'Thinking', checking: 'Running your checks', reviewing: 'Reviewing your code' } as const;
const SLOW_AFTER_S = 20;
let waiting: { readonly activity: keyof typeof ACTIVITY_TEXT; readonly since: number; readonly timer: number } | undefined;

const send = (message: FromWebview) => () => {
  vscode.postMessage(message);
};
const actions = {
  copy: (text: string) => {
    vscode.postMessage({ type: 'copy', text });
  },
  openFile: (ref: FileRef) => {
    vscode.postMessage({ type: 'openFile', ...ref });
  },
};

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  render(event.data.state);
});
vscode.postMessage({ type: 'ready' });

function render(state: ViewState): void {
  current = state;
  trackWait(state);
  const focused = document.activeElement?.id;
  root.replaceChildren(...(state.phase === 'idle' ? idleView(state) : sessionView(state)));
  if (focused) document.getElementById(focused)?.focus();

  const transcript = document.getElementById('transcript');
  if (transcript && state.transcript.length !== renderedEntries) {
    transcript.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  renderedEntries = state.transcript.length;
}

// Before a session -----------------------------------------------------------

function idleView(state: ViewState): Node[] {
  if (state.model === undefined || state.needsFolder) return gettingStarted(state);

  const goal = el('textarea', { id: 'goal', rows: 3, placeholder: 'Add pagination to the posts page' });
  goal.value = drafts.goal;
  goal.addEventListener('input', () => (drafts.goal = goal.value));
  const start = () => {
    if (drafts.goal.trim() === '') {
      goal.focus();
      return;
    }
    vscode.postMessage({ type: 'start', goal: drafts.goal });
    drafts.goal = '';
  };
  goal.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) start();
  });

  const examples = EXAMPLE_GOALS.map((example) =>
    button(example, () => {
      drafts.goal = example;
      if (current) render(current);
      document.getElementById('goal')?.focus();
    }, { style: 'chip', disabled: busy(state) }),
  );

  return [
    el('section', { className: 'stack' }, [
      el('h2', { text: 'What do you want to build?' }),
      el('p', { className: 'muted', text: 'Describe one feature. BuildWise splits it into small steps and gives hints; you write the code.' }),
      el('label', { className: 'field-label', htmlFor: 'goal', text: 'Your goal' }),
      goal,
      el('div', { className: 'row' }, [
        button(state.activity ? 'Planning…' : 'Start session', start, { style: 'primary', disabled: busy(state) }),
        el('span', { className: 'muted small', text: START_KEYS }),
      ]),
      ...statusLine(),
    ]),
    el('section', { className: 'stack examples' }, [el('div', { className: 'section-label', text: 'Not sure? Try one' }), ...examples]),
    el('p', { className: 'muted small model-line' }, [
      document.createTextNode(`Using ${state.model}. `),
      button('Change', send({ type: 'setup' }), { style: 'link' }),
    ]),
    ...(state.transcript.length ? [transcriptView(state)] : []),
  ];
}

/** The steps before a first session: a model, then a project folder. */
function gettingStarted(state: ViewState): Node[] {
  const hasModel = state.model !== undefined;
  const step = (done: boolean, title: string, text: string, action: HTMLButtonElement) =>
    el('li', { className: `step ${done ? 'passed' : 'active'}` }, [
      stepMarker(done ? 'passed' : 'active'),
      el('div', { className: 'step-body' }, [
        el('div', { className: 'step-title', text: title }),
        ...(done ? [] : [el('p', { className: 'muted', text }), action]),
      ]),
    ]);
  return [
    el('section', { className: 'stack' }, [
      el('h2', { text: 'Get started' }),
      el('p', { className: 'muted', text: 'BuildWise is a mentor: it plans a feature with you and gives hints, and you write the code.' }),
    ]),
    el('ol', { className: 'stepper' }, [
      step(
        hasModel,
        'Choose an AI model',
        'BuildWise needs a model to plan and give hints. Google Gemini and Groq have free tiers.',
        button('Set up a model', send({ type: 'setup' }), { style: 'primary' }),
      ),
      step(
        !state.needsFolder,
        'Open your project',
        'Open the folder of the project you want to build in.',
        button('Open Folder', send({ type: 'openFolder' }), { style: hasModel ? 'primary' : 'secondary' }),
      ),
    ]),
  ];
}

// During a session -----------------------------------------------------------

function sessionView(state: ViewState): Node[] {
  const tip = nextStep(state, SAVE_KEYS);
  return [
    sessionHeader(state),
    stepper(state),
    ...(tip ? [el('div', { className: 'tip' }, [icon('lightbulb', 'tip-icon'), el('p', { text: tip })])] : []),
    transcriptView(state),
    ...statusLine(),
    state.phase === 'complete' ? completeActions() : sessionActions(state),
  ];
}

function sessionHeader(state: ViewState): HTMLElement {
  const goal = state.transcript.find((entry) => entry.kind === 'goal')?.text ?? '';
  const total = state.checkpoints.length;
  const passed = state.checkpoints.filter((c) => c.status === 'passed').length;
  const active = state.checkpoints.findIndex((c) => c.status === 'active');
  const progressText = {
    idle: '',
    planning: 'Planning',
    building: `Step ${String(active + 1)} of ${String(total)}`,
    'independent-check': 'Final step: independent check',
    complete: 'Session complete',
  }[state.phase];
  const done = state.phase === 'complete' || state.phase === 'independent-check' ? total : passed;

  const fill = el('div', { className: 'progress-fill' });
  fill.style.setProperty('width', `${String(total ? Math.round((done / total) * 100) : 0)}%`);
  const bar = el('div', { className: 'progress', ariaLabel: `${String(done)} of ${String(total)} steps done` }, [fill]);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(done));

  return el('header', { className: 'session-header stack-tight' }, [
    el('div', { className: 'goal', text: goal, title: goal }),
    el('div', { className: 'row spread small' }, [
      el('span', { text: progressText }),
      el('span', { className: 'muted', text: `${String(done)}/${String(total)} done` }),
    ]),
    bar,
  ]);
}

function stepper(state: ViewState): HTMLElement {
  return el(
    'ol',
    { className: 'stepper' },
    state.checkpoints.map((checkpoint, index) =>
      el('li', { className: `step ${checkpoint.status}` }, [
        stepMarker(checkpoint.status, index + 1),
        el('div', { className: 'step-body' }, [
          el('div', { className: 'step-title', text: checkpoint.title }),
          ...(checkpoint.status === 'active' ? [el('p', { className: 'muted', text: checkpoint.description })] : []),
        ]),
      ]),
    ),
  );
}

function stepMarker(status: 'passed' | 'active' | 'pending', number?: number): HTMLElement {
  const marker = el('span', { className: 'step-marker', ariaHidden: true });
  if (status === 'passed') marker.append(icon('check'));
  else if (number !== undefined) marker.textContent = String(number);
  return marker;
}

function transcriptView(state: ViewState): HTMLElement {
  // In a session the goal is already shown in the header.
  const entries = state.phase === 'idle' ? state.transcript : state.transcript.filter((entry) => entry.kind !== 'goal');
  return el('div', { id: 'transcript', className: 'transcript' }, entries.map(entryView));
}

const ENTRY_ICONS: Partial<Record<Entry['kind'], IconName>> = {
  hint: 'lightbulb',
  solution: 'book',
  answer: 'chat',
  challenge: 'target',
  explanation: 'info',
  check: 'error',
  summary: 'trophy',
};

function entryView(entry: Entry): HTMLElement {
  if (entry.from === 'learner') {
    return el('article', { className: 'entry learner' }, [
      el('div', { className: 'entry-label', text: entry.kind === 'goal' ? 'Goal' : 'You' }),
      el('p', { text: entry.text }),
    ]);
  }
  if (entry.kind === 'notice') {
    const name: IconName = entry.tone === 'success' ? 'check' : entry.tone === 'error' ? 'error' : 'info';
    return el('div', { className: `notice ${entry.tone ?? ''}`.trim() }, [icon(name, 'notice-icon'), el('p', { text: entry.text })]);
  }
  if (entry.kind === 'plan') {
    // The steps list shows the plan already; keep the full text one click away.
    return el('details', { className: 'card plan' }, [
      el('summary', { className: 'entry-label' }, [icon('list'), document.createTextNode('Full plan')]),
      richText(entry.text, actions),
    ]);
  }

  const children: Node[] = [
    el('div', { className: 'entry-label' }, [icon(ENTRY_ICONS[entry.kind] ?? 'chat'), document.createTextNode(entry.label ?? 'Mentor')]),
  ];
  if (entry.kind === 'summary' && entry.summary) children.push(summaryTiles(entry.summary));
  else if (entry.kind === 'check') children.push(...checkBody(entry));
  else children.push(richText(entry.text, actions));

  return el('article', { className: `card ${entry.kind} ${entry.tone ?? ''}`.trim() }, children);
}

function checkBody(entry: Entry): Node[] {
  const [headline = '', ...notes] = entry.text.split('\n');
  const problems = entry.problems ?? [];
  const rows = problems.slice(0, MAX_LISTED_PROBLEMS).map((problem) => {
    const where = problem.file ? `${problem.file}${problem.line ? `:${String(problem.line)}` : ''}` : '';
    const content = [
      ...(where ? [el('span', { className: 'problem-where', text: where })] : []),
      el('span', { className: 'problem-code', text: problem.code }),
      el('span', { className: 'problem-message', text: problem.message }),
    ];
    if (!problem.file) return el('li', { className: 'problem' }, content);
    const ref: FileRef = {
      file: problem.file,
      ...(problem.line && { line: problem.line }),
      ...(problem.column && { column: problem.column }),
    };
    return el('li', {}, [
      button(content, () => {
        actions.openFile(ref);
      }, { style: 'problem', ariaLabel: `Open ${where}: ${problem.message}` }),
    ]);
  });
  if (problems.length > MAX_LISTED_PROBLEMS) {
    rows.push(el('li', { className: 'muted small', text: `…and ${String(problems.length - MAX_LISTED_PROBLEMS)} more` }));
  }
  return [
    el('p', { text: headline }),
    ...(rows.length ? [el('ul', { className: 'problems' }, rows)] : []),
    ...notes.map((note) => el('p', { className: 'muted small', text: note })),
  ];
}

function summaryTiles(summary: NonNullable<Entry['summary']>): HTMLElement {
  const tile = (value: string, label: string, tone = '') =>
    el('div', { className: `tile ${tone}`.trim() }, [
      el('div', { className: 'tile-value', text: value }),
      el('div', { className: 'tile-label', text: label }),
    ]);
  return el('div', { className: 'tiles' }, [
    tile(`${String(summary.checkpointsPassed)}/${String(summary.checkpointsTotal)}`, 'steps passed'),
    tile(String(summary.checkpointsUnassisted), 'without help'),
    tile(String(summary.hintsUsed), summary.hintsUsed === 1 ? 'hint' : 'hints'),
    tile(String(summary.questionsAsked), summary.questionsAsked === 1 ? 'question' : 'questions'),
    tile(String(summary.solutionsRevealed), summary.solutionsRevealed === 1 ? 'solution seen' : 'solutions seen'),
    summary.independentCheckPassed ? tile('Passed', 'independent check', 'success') : tile('Not done', 'independent check'),
  ]);
}

function sessionActions(state: ViewState): HTMLElement {
  const building = state.phase === 'building';
  const primary: Node[] = [button('Check my work', send({ type: 'check' }), { style: 'primary', disabled: busy(state) })];

  if (building) {
    const used = state.hintsUsed;
    const left = used < state.hintLevels;
    const dots = el(
      'span',
      { className: 'dots', ariaHidden: true },
      Array.from({ length: state.hintLevels }, (_, i) => el('span', { className: i < used ? 'dot used' : 'dot' })),
    );
    primary.push(
      button([icon('lightbulb'), el('span', { text: left ? 'Hint' : 'No hints left' }), dots], send({ type: 'hint' }), {
        disabled: busy(state) || !left,
        ariaLabel: left ? `Get hint ${String(used + 1)} of ${String(state.hintLevels)}` : 'No hints left',
      }),
    );
  }

  const secondary: Node[] = [];
  if (building && state.canExplain) {
    secondary.push(button([icon('info'), el('span', { text: 'Explain the errors' })], send({ type: 'explain' }), { disabled: busy(state) }));
  }
  if (building && state.revealUnlocked) {
    secondary.push(button([icon('book'), el('span', { text: 'Reveal solution' })], send({ type: 'reveal' }), { disabled: busy(state) }));
  }

  return el('footer', { className: 'actions' }, [
    el('div', { className: 'row wrap' }, primary),
    ...(secondary.length ? [el('div', { className: 'row wrap' }, secondary)] : []),
    ...(building
      ? [askForm(state)]
      : [el('p', { className: 'muted small', text: 'Hints and questions are off for the independent check.' })]),
    button('End session', send({ type: 'end' }), { style: 'link', disabled: busy(state) }),
  ]);
}

function askForm(state: ViewState): HTMLElement {
  const input = el('input', {
    id: 'question',
    type: 'text',
    placeholder: 'Ask about this step, then press Enter',
    ariaLabel: 'Ask a question',
  });
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
  return el('footer', { className: 'actions' }, [button('Start a new session', send({ type: 'new' }), { style: 'primary' })]);
}

// Waiting -------------------------------------------------------------------

function trackWait(state: ViewState): void {
  if (state.activity === waiting?.activity) return;
  if (waiting) clearInterval(waiting.timer);
  waiting = state.activity
    ? { activity: state.activity, since: Date.now(), timer: window.setInterval(updateStatus, 1000) }
    : undefined;
}

function statusText(): string {
  if (!waiting) return '';
  const elapsed = Math.floor((Date.now() - waiting.since) / 1000);
  const slow = elapsed >= SLOW_AFTER_S ? ' This is taking a while; details are in Output → BuildWise.' : '';
  return `${ACTIVITY_TEXT[waiting.activity]}… ${String(elapsed)}s.${slow}`;
}

function updateStatus(): void {
  const status = document.getElementById('status');
  if (status) status.textContent = statusText();
}

function statusLine(): HTMLElement[] {
  if (!waiting) return [];
  const status = el('p', { id: 'status', className: 'status', text: statusText() });
  status.setAttribute('role', 'status');
  return [status];
}

function busy(state: ViewState): boolean {
  return state.activity !== undefined;
}
