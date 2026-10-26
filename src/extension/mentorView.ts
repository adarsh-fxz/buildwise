import * as vscode from 'vscode';
import { instrument, seconds } from '../core/mentor/instrument';
import { activeCheckpoint, HINT_LEVELS } from '../core/session/session';
import { Tutor, type TutorState } from '../core/tutor/tutor';
import type { FromWebview, ToWebview, ViewState } from '../webview/protocol';
import { describeConfigured, loadMentor, setupProvider } from './provider';
import { runChecks } from './checks';
import { ChangeTracker, EditorTracker, readSavedFiles, repositoryContext } from './editorContext';
import { type FolderScan, scanFolder } from './workspaceFiles';
import { isWorkspaceRelative } from '../webview/fileRef';

interface ActiveSession {
  readonly tutor: Tutor;
  readonly folder: vscode.WorkspaceFolder;
  readonly scan: FolderScan;
  readonly changes: ChangeTracker;
}

export class MentorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'buildwise.mentor';

  private view: vscode.WebviewView | undefined;
  private active: ActiveSession | undefined;
  private starting = false;
  private latest: TutorState | undefined;
  private model: string | undefined;
  private readonly editors = new EditorTracker();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly workspaceState: vscode.Memento,
    private readonly output: vscode.OutputChannel,
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
    // Keep the getting-started steps current however setup happens.
    const refresh = () => void this.refreshSetup();
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('buildwise')) refresh();
      }),
      this.secrets.onDidChange(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    );
  }

  dispose(): void {
    this.editors.dispose();
    this.active?.changes.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async refreshSetup(): Promise<void> {
    this.model = await describeConfigured(this.secrets);
    this.post(this.latest);
  }

  private async handle(message: FromWebview): Promise<void> {
    const tutor = this.active?.tutor;
    switch (message.type) {
      case 'ready':
        this.latest = tutor?.state;
        await this.refreshSetup();
        return;
      case 'setup':
        await setupProvider(this.secrets);
        return;
      case 'openFolder':
        await vscode.commands.executeCommand('vscode.openFolder');
        return;
      case 'openFile':
        await this.openFile(message.file, message.line, message.column);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
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
      const loaded = await loadMentor(this.secrets);
      if (!loaded) return;
      const mentor = instrument(loaded, (line) => {
        this.log(line);
      });
      this.log(`Session started with ${this.model ?? 'the configured model'}.`);
      this.active?.changes.dispose();
      const changes = new ChangeTracker(folder);
      const scanStarted = Date.now();
      const scan = await scanFolder(folder);
      this.log(`Scanned ${String(scan.files.length)} files in ${seconds(Date.now() - scanStarted)}.`);
      const tutor = new Tutor(mentor, repositoryContext(scan, this.editors), (state) => {
        this.post(state);
      });
      this.active = { tutor, folder, scan, changes };
      await tutor.start(goal);
    } finally {
      this.starting = false;
    }
  }

  private async check(): Promise<void> {
    if (!this.active) return;
    const { tutor, folder, scan, changes } = this.active;
    await tutor.check(async () => {
      const started = Date.now();
      const files = await readSavedFiles(changes, scan);
      const report = await runChecks(folder, changes, this.workspaceState, files);
      this.log(`check: ${report.scope}, ${String(report.evidence.errors)} errors, tests ${report.evidence.tests}, in ${seconds(Date.now() - started)}`);
      return report;
    });
  }

  /** Opens a file the mentor or a check mentioned. The path comes from model output, so it is checked first. */
  private async openFile(file: string, line?: number, column?: number): Promise<void> {
    const folder = this.active?.folder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder || !isWorkspaceRelative(file)) return;
    const uri = vscode.Uri.joinPath(folder.uri, ...file.split('/'));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showWarningMessage(`${file} is not in this project.`);
      return;
    }
    const position = new vscode.Position(Math.max((line ?? 1) - 1, 0), Math.max((column ?? 1) - 1, 0));
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(position, position),
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  private post(state: TutorState | undefined): void {
    this.latest = state;
    const message: ToWebview = {
      type: 'state',
      state: toViewState(state, this.model, !vscode.workspace.workspaceFolders?.length),
    };
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

function toViewState(state: TutorState | undefined, model: string | undefined, needsFolder: boolean): ViewState {
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
    model,
    needsFolder,
  };
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
