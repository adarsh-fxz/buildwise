// Messages between the extension and the mentor webview. Type-only, so the
// webview bundle doesn't pull in core code.
import type { Checkpoint, Phase } from '../core/session/session';
import type { TranscriptEntry } from '../core/tutor/tutor';

export interface ViewState {
  /** `idle` means no session yet: show the goal input. */
  readonly phase: Phase | 'idle';
  readonly checkpoints: readonly Pick<Checkpoint, 'title' | 'description' | 'status'>[];
  readonly hintsUsed: number;
  readonly hintLevels: number;
  readonly revealUnlocked: boolean;
  readonly busy: boolean;
  readonly transcript: readonly TranscriptEntry[];
}

export type ToWebview = { readonly type: 'state'; readonly state: ViewState };

export type FromWebview =
  | { readonly type: 'ready' }
  | { readonly type: 'start'; readonly goal: string }
  | { readonly type: 'hint' }
  | { readonly type: 'reveal' }
  | { readonly type: 'check' }
  | { readonly type: 'ask'; readonly question: string }
  | { readonly type: 'end' }
  | { readonly type: 'new' };
