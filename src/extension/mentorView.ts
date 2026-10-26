import * as vscode from 'vscode';
import { activeCheckpoint, HINT_LEVELS, type Session } from '../core/session/session';
import { Tutor, type TutorState } from '../core/tutor/tutor';
import type { FromWebview, ToWebview, ViewState } from '../webview/protocol';
import { loadMentor } from './provider';
import { runChecks } from './checks';
import { ChangeTracker, EditorTracker, repositoryContext } from './editorContext';
import { scanFolder } from './workspaceFiles';

interface ActiveSession {
  readonly tutor: Tutor;
  readonly folder: vscode.WorkspaceFolder;
  readonly changes: ChangeTracker;
}

export class MentorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'buildwise.mentor';

  private view: vscode.WebviewView | undefined;
  private active: ActiveSession | undefined;
  private starting = false;
  private readonly editors = new EditorTracker();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly workspaceState: vscode.Memento,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: FromWebview) => {
      void this.handle(message);
    });
  }

  dispose(): void {
    this.editors.dispose();
    this.active?.changes.dispose();
  }

  private async handle(message: FromWebview): Promise<void> {
    const tutor = this.active?.tutor;
    switch (message.type) {
      case 'ready':
        this.post(tutor?.state);
        return;
      case 'start':
        await this.start(message.goal);
        return;
      case 'hint':
        await tutor?.hint();
        return;
      case 'reveal':
        await tutor?.reveal();
        return;
      case 'ask':
        await tutor?.ask(message.question);
        return;
      case 'check':
        await this.check();
        return;
      case 'explain':
        await tutor?.explain();
        return;
      case 'end':
        tutor?.end();
        return;
      case 'new':
        if (tutor?.state.session?.phase === 'complete') {
          this.active?.changes.dispose();
          this.active = undefined;
          this.post(undefined);
        }
        return;
    }
  }

  private async start(goal: string): Promise<void> {
    const inProgress = this.active?.tutor.state.session;
    if (this.starting || goal.trim() === '' || (inProgress && inProgress.phase !== 'complete')) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showInformationMessage('Open the project you want to work on, then start a session.');
      return;
    }

    this.starting = true;
    try {
      const mentor = await loadMentor(this.secrets);
      if (!mentor) return;
      this.active?.changes.dispose();
      const changes = new ChangeTracker(folder);
      const scan = await scanFolder(folder);
      const tutor = new Tutor(mentor, repositoryContext(scan, this.editors), (state) => {
        this.post(state);
      });
      this.active = { tutor, folder, changes };
      await tutor.start(goal);
    } finally {
      this.starting = false;
    }
  }

  private async check(): Promise<void> {
    if (!this.active) return;
    const { tutor, folder, changes } = this.active;
    const before = position(tutor.state.session);
    await tutor.check(() => runChecks(folder, changes, this.workspaceState));
    // Work for the next checkpoint starts from a clean slate.
    if (position(tutor.state.session) !== before) changes.reset();
  }

  private post(state: TutorState | undefined): void {
    const message: ToWebview = { type: 'state', state: toViewState(state) };
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
    const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...path)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'view.css')}">
  <title>BuildWise</title>
</head>
<body>
  <main id="root"></main>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}

/** Identifies where a session is, so the view can tell when a check moved it on. */
function position(session: Session | undefined): string {
  if (!session) return 'none';
  return `${session.phase}:${String(session.checkpoints.findIndex((c) => c.status === 'active'))}`;
}

function toViewState(state: TutorState | undefined): ViewState {
  const session = state?.session;
  const current = session && activeCheckpoint(session);
  return {
    phase: session?.phase ?? 'idle',
    checkpoints: (session?.checkpoints ?? []).map(({ title, description, status }) => ({ title, description, status })),
    hintsUsed: current?.hintsUsed ?? 0,
    hintLevels: HINT_LEVELS,
    revealUnlocked: current !== undefined && current.hintsUsed >= HINT_LEVELS && !current.solutionRevealed,
    canExplain: state?.canExplain ?? false,
    activity: state?.activity,
    transcript: state?.transcript ?? [],
  };
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
