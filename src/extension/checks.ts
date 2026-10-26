import * as vscode from 'vscode';
import { buildReport, type CommandOverrides, detectCommands, type ProjectFacts } from '../core/checks/commands';
import type { CheckReport } from '../core/checks/report';
import { runCommand } from '../core/checks/run';
import { type ChangeTracker, editorReport } from './editorContext';

const TYPECHECK_TIMEOUT_MS = 2 * 60_000;
const TEST_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_KEY = 'buildwise.allowedCheckCommands';
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/**
 * Runs the project's type checker and tests, after the learner approves the
 * exact commands. Falls back to the editor's errors whenever they don't run.
 */
export async function runChecks(
  folder: vscode.WorkspaceFolder,
  changes: ChangeTracker,
  state: vscode.Memento,
): Promise<CheckReport> {
  const editor = editorReport(folder, changes);
  if (!vscode.workspace.isTrusted) {
    return { ...editor, notes: ['Type checks and tests are off because this workspace is not trusted.'] };
  }

  const commands = detectCommands(await projectFacts(folder), overrides(folder));
  const toRun = [commands.typecheck, commands.test].filter((command) => command !== undefined);
  if (toRun.length === 0) return editor;
  if (!(await confirm(toRun, folder, state))) {
    return { ...editor, notes: ['You chose not to run the type check and tests, so editor errors were used.'] };
  }

  const cwd = folder.uri.fsPath;
  const [typecheck, test] = await Promise.all([
    commands.typecheck === undefined ? undefined : runCommand(commands.typecheck, cwd, TYPECHECK_TIMEOUT_MS),
    commands.test === undefined ? undefined : runCommand(commands.test, cwd, TEST_TIMEOUT_MS),
  ]);
  return buildReport({ ...(typecheck && { typecheck }), ...(test && { test }) }, editor);
}

export async function resetCheckPermissions(state: vscode.Memento): Promise<void> {
  await state.update(ALLOWED_KEY, undefined);
  void vscode.window.showInformationMessage('BuildWise will ask again before running checks in this workspace.');
}

async function confirm(commands: readonly string[], folder: vscode.WorkspaceFolder, state: vscode.Memento): Promise<boolean> {
  const allowed = state.get<string[]>(ALLOWED_KEY, []);
  if (commands.every((command) => allowed.includes(command))) return true;

  const always = 'Always Allow in This Workspace';
  const choice = await vscode.window.showWarningMessage(
    `BuildWise wants to run these commands in ${folder.name} to check your work:`,
    {
      modal: true,
      detail: `${commands.join('\n')}\n\nThey run with your permissions, as if you typed them in a terminal. You can change them in the buildwise.checks settings.`,
    },
    'Run Once',
    always,
  );
  if (choice === always) {
    await state.update(ALLOWED_KEY, [...new Set([...allowed, ...commands])]);
  }
  return choice !== undefined;
}

async function projectFacts(folder: vscode.WorkspaceFolder): Promise<ProjectFacts> {
  const exists = async (name: string) => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, name));
      return true;
    } catch {
      return false;
    }
  };
  let packageJson: string | undefined;
  try {
    packageJson = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'package.json')),
    );
  } catch {
    packageJson = undefined;
  }
  const lockfiles: string[] = [];
  for (const name of LOCKFILES) {
    if (await exists(name)) lockfiles.push(name);
  }
  return { hasTsconfig: await exists('tsconfig.json'), packageJson, lockfiles };
}

function overrides(folder: vscode.WorkspaceFolder): CommandOverrides {
  const config = vscode.workspace.getConfiguration('buildwise.checks', folder);
  const read = (key: string) => config.get<string | null>(key) ?? undefined;
  return { typecheck: read('typecheckCommand'), test: read('testCommand') };
}
