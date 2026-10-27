// Messages between the extension and the mentor webview. Type-only, so the
// webview bundle doesn't pull in core code.
import type { Progress } from '../core/progress/log';
import type { Checkpoint, Phase } from '../core/session/session';
import type { Activity, TranscriptEntry } from '../core/tutor/tutor';

export interface ViewState {
  /** `idle` means no session yet: show the goal input. */
  readonly phase: Phase | 'idle';
  readonly checkpoints: readonly Pick<Checkpoint, 'title' | 'description' | 'status'>[];
  readonly hintsUsed: number;
  readonly hintLevels: number;
  readonly revealUnlocked: boolean;
  readonly canExplain: boolean;
  /** Set while waiting on the model or the learner's tools; actions are disabled. */
  readonly activity: Activity | undefined;
  readonly transcript: readonly TranscriptEntry[];
  /** The model in use, such as "gemini-3.8-flash from Google Gemini"; undefined until set up. */
  readonly model: string | undefined;
  /** Undefined until a provider is set up. */
  readonly choice: ModelChoice | undefined;
  readonly needsFolder: boolean;
  /** From the learning log; undefined until a session has been recorded. */
  readonly progress: Progress | undefined;
}

/** What the provider, model and effort menus under the input box show. */
export interface ModelChoice {
  readonly providers: readonly {
    readonly id: string;
    readonly label: string;
    readonly free: boolean;
    /** False when choosing it needs setup first, such as an API key. */
    readonly ready: boolean;
  }[];
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly efforts: readonly string[];
}

export type ToWebview =
  | { readonly type: 'state'; readonly state: ViewState }
  /** The live model list for `provider`, or why it could not be fetched. */
  | { readonly type: 'models'; readonly provider: string; readonly models: readonly string[]; readonly error?: string };

export type FromWebview =
  | { readonly type: 'ready' }
  | { readonly type: 'start'; readonly goal: string }
  | { readonly type: 'hint' }
  | { readonly type: 'reveal' }
  | { readonly type: 'check' }
  | { readonly type: 'explain' }
  | { readonly type: 'ask'; readonly question: string }
  | { readonly type: 'end' }
  | { readonly type: 'new' }
  | { readonly type: 'setup' }
  | { readonly type: 'openFolder' }
  | { readonly type: 'openFile'; readonly file: string; readonly line?: number; readonly column?: number }
  | { readonly type: 'copy'; readonly text: string }
  | { readonly type: 'savePilotReport' }
  | { readonly type: 'chooseProvider'; readonly provider: string }
  | { readonly type: 'listModels' }
  | { readonly type: 'chooseModel'; readonly model: string }
  | { readonly type: 'chooseEffort'; readonly effort: string };
