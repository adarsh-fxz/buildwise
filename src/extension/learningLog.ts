import * as vscode from 'vscode';
import { type LogEntry, parseLog, recordSession } from '../core/progress/log';

// globalState lives on this machine and is not synced unless an extension opts in.
const KEY = 'buildwise.learningLog';

/** Finished sessions, kept on the learner's machine and never uploaded. */
export class LearningLog {
  constructor(private readonly state: vscode.Memento) {}

  entries(): LogEntry[] {
    return parseLog(this.state.get(KEY));
  }

  async record(entry: LogEntry): Promise<void> {
    await this.state.update(KEY, recordSession(this.entries(), entry));
  }

  /** Asks first; returns whether the log was cleared. */
  async clear(): Promise<boolean> {
    const count = this.entries().length;
    if (count === 0) {
      void vscode.window.showInformationMessage('Your learning log is already empty.');
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete your learning log of ${String(count)} ${count === 1 ? 'session' : 'sessions'}?`,
      { modal: true, detail: 'Your progress on the BuildWise start screen will start again from zero.' },
      'Delete',
    );
    if (choice !== 'Delete') return false;
    await this.state.update(KEY, undefined);
    return true;
  }
}
