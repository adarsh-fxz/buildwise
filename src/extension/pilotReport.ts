import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { buildPilotReport } from '../core/progress/report';
import type { LearningLog } from './learningLog';

const PILOT_ID_KEY = 'buildwise.pilotId';

/** Saves an anonymous report for the learner to send; nothing is uploaded. */
export async function savePilotReport(log: LearningLog, state: vscode.Memento, extensionVersion: string): Promise<void> {
  const entries = log.entries();
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('Finish a session first: the report is made from your learning log.');
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Save an anonymous report of your ${String(entries.length)} ${entries.length === 1 ? 'session' : 'sessions'}?`,
    {
      modal: true,
      detail:
        'It holds counts only: steps, hints, questions, how long each session took and the days between them. ' +
        'No goals, code, file names or model output. Nothing is sent: you choose who gets the file.',
    },
    'Save Report…',
  );
  if (!choice) return;

  const report = buildPilotReport(entries, { pilotId: await pilotId(state), extensionVersion, now: new Date() });
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(join(homedir(), `buildwise-report-${report.exportedOn}.json`)),
    filters: { JSON: ['json'] },
    saveLabel: 'Save Report',
  });
  if (!uri) return;

  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`));
  const open = await vscode.window.showInformationMessage(`Saved ${uri.fsPath}. Send it to the BuildWise team.`, 'Open Report');
  if (open) await vscode.window.showTextDocument(uri);
}

async function pilotId(state: vscode.Memento): Promise<string> {
  const existing = state.get<string>(PILOT_ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  await state.update(PILOT_ID_KEY, id);
  return id;
}
