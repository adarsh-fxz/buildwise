import type { ViewState } from './protocol';

/**
 * One sentence telling a beginner what to do now. Undefined while BuildWise
 * is busy, since the status line covers that.
 */
export function nextStep(state: ViewState, saveKeys: string): string | undefined {
  if (state.activity) return undefined;
  const last = state.transcript.at(-1);

  switch (state.phase) {
    case 'idle':
    case 'planning':
      return undefined;
    case 'complete':
      return 'Session finished. Read your summary, then start a new session when you are ready.';
    case 'independent-check':
      return `Build this one on your own: hints and questions are off. Save with ${saveKeys}, then check your work.`;
    case 'building':
      if (last?.kind === 'check' && last.tone === 'error') {
        return state.canExplain
          ? 'Fix the first error in the list, save, and check again. Not sure what it means? Explain the errors.'
          : 'Fix the first error in the list, save, and check again.';
      }
      if (state.revealUnlocked) {
        return 'You have used every hint. Keep trying, or reveal the solution and type it out yourself.';
      }
      if (state.hintsUsed > 0) {
        return `Try the hint in your code. Save with ${saveKeys}, then check your work.`;
      }
      return `Write the code for this step in your editor. Save with ${saveKeys}, then check your work. Stuck? Ask for a hint.`;
  }
}
