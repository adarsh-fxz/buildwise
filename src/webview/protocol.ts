// Messages between the extension and the mentor webview. Type-only, so the
// webview bundle doesn't pull in core code.
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
  readonly needsFolder: boolean;
}

export type ToWebview = { readonly type: 'state'; readonly state: ViewState };

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
  | { readonly type: 'copy'; readonly text: string };
