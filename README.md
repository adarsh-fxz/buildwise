# BuildWise

A VS Code mentor that teaches you to build a feature in your own codebase, instead of building it for you.

**Status:** pre-alpha. Not usable yet. See the [roadmap](#roadmap) for what works today.

## Why

Coding agents now write a large share of the code in new projects. That works for people who already know how to build software. It fails the people who are supposed to be learning: students, self-taught developers and junior engineers. They can ship a feature with an agent and still be unable to explain it, debug it, or do it again without help.

Junior engineers used to close that gap on the job, next to a senior engineer. Entry-level hiring has shrunk, so fewer people get that apprenticeship.

BuildWise is that senior engineer: in your editor, on your real project, asking the next question instead of writing the next line.

## How a session works

1. **You set a goal.** "Add pagination to the posts page."
2. **BuildWise reads the relevant code** (only files you allow) and breaks the goal into 3–6 checkpoints.
3. **You write the code.** When you're stuck, you ask for a hint. Hints escalate from a question, to a pointer at the right file and line, to a concrete explanation. A full solution is only available as an explicit reveal, and the session records that you used it.
4. **Your toolchain checks the work.** When you check your work, BuildWise runs your type checker and tests, after you approve the exact commands, and lists the errors. A checkpoint passes when the code compiles and the tests pass, not when the model thinks it looks right. If you're stuck on an error, BuildWise explains what it means without writing the fix.
5. **You prove it.** The session ends with a short task on the same concept, with hints turned off, and a recap of where you needed help.

```text
You:        I want to add pagination to the posts page.
BuildWise:  Your posts come from getPosts() in src/lib/posts.ts. It returns every
            row. What would the function need to know to return only page 2?
You:        The page number?
BuildWise:  And how many posts fit on a page. Add both as parameters. The query
            on line 14 is where they'll be used.
            ...
            [save] TS2345 in src/app/posts/page.tsx:22: getPosts() now expects
            two arguments. Where does the page number come from on this route?
```

## How this differs from what exists

Teaching modes exist already: Claude Code's *Learning* output style, Claude's and ChatGPT's study modes, Harvard's CS50 Duck, and Socratic tutors such as CodeTrain. BuildWise makes three specific bets:

- **The teaching policy is code, not a prompt.** Checkpoints, hint levels and solution reveals are enforced by a state machine. A prompt-based learning mode is one request away from writing the whole feature. BuildWise can only do that through an explicit, recorded reveal.
- **Verification comes from the toolchain.** Feedback is anchored in TypeScript diagnostics and test output, so mistakes are caught by the compiler instead of by a model that can be confidently wrong.
- **It measures independence.** Every session records hints used per checkpoint and ends with an unassisted task. Over time, that is evidence that someone can do the work alone, which is what a learner, an instructor or an employer actually wants to know.

None of this is proven yet. The pilot compares BuildWise directly against Claude Code's Learning mode, because a free toggle is the real alternative.

## Scope of the first version

**For:** developers learning TypeScript, React, Next.js or Node.js, working in VS Code on a real project.

**In:** repository-aware guidance, checkpoint plans, escalating hints, diagnostics and test feedback, an end-of-session independent check.

**Out:** voice (planned after the pilot; typed comes first), other languages and editors, autonomous multi-file edits, running commands without asking, team features.

## Try it

BuildWise only runs from source for now.

1. Clone this repository, run `npm install`, open it in VS Code and press <kbd>F5</kbd>.
2. In the window that opens, open a TypeScript project.
3. Run **BuildWise: Set Up Model Provider**, choose a provider, paste its API key and pick a model. See [Models](#models) for free options.
4. Open BuildWise in the activity bar and describe what you want to build.

**Check my work** runs `tsc --noEmit` when the project has a `tsconfig.json`, and the `test` script from `package.json`. BuildWise asks before the first run and shows the exact commands. Change them with `buildwise.checks.typecheckCommand` and `buildwise.checks.testCommand`, or set either to an empty string to skip it. If a command can't run, BuildWise falls back to the errors VS Code reports and tells you.

Current limits: the mentor sees your file list and the file you have open, not the whole repository. A checkpoint passes on a clean compile and passing tests; nothing yet checks that your change matches the checkpoint.

## Models

BuildWise works with any of these. Run **BuildWise: Set Up Model Provider** to switch; the model list comes live from the provider, so it is always current.

| Provider | Cost | Notes |
| --- | --- | --- |
| [Google Gemini](https://aistudio.google.com/apikey) | Free tier | No card needed. The easiest free start. |
| [Groq](https://console.groq.com/keys) | Free tier | Very fast. Small per-minute limits, so BuildWise sends a shorter excerpt of your open file. |
| [OpenRouter](https://openrouter.ai/keys) | Free models | Only models marked `:free` are listed, about 50 requests a day. |
| [Ollama](https://ollama.com) | Free | Runs on your computer, so nothing leaves it. Needs a capable machine. |
| [Anthropic Claude](https://console.anthropic.com) | Paid | |
| Other | Varies | Any OpenAI-compatible endpoint, such as Mistral or Cerebras. |

Free tiers change often and have daily limits. Smaller models give weaker hints and may struggle with the plan format; BuildWise retries once and tells you if it fails. Read your provider's terms before using a free tier with code you can't share: some free tiers, including Gemini's, may use what you send to improve their models.

## Privacy

Nothing is sent anywhere until you start a session. During a session, BuildWise sends the model provider you chose your goal and questions, the paths of shareable files (up to 300), the contents of the file open in your editor if that file is shareable, and, when you ask for an explanation, the errors and the end of the test output. Your API key is stored in the OS keychain through VS Code's secret storage.

BuildWise only ever considers files in the open workspace, and filters them before anything can reach a model provider. It never shares:

- `.env` files (templates such as `.env.example` are allowed)
- private keys, certificates, keystores and credential files (`*.pem`, `id_rsa`, `.npmrc`, `.aws/`, ...)
- anything matched by the workspace's root `.gitignore`
- dependency folders, build output, lockfiles and binary files
- files larger than 256 KB, or anything you exclude in settings

Run **BuildWise: Show Shared Context** from the command palette to see which files are shareable and why each excluded file was excluded.

BuildWise is read-only: it never edits your files. It runs only the check commands you approve, never in an untrusted workspace, and run **BuildWise: Ask Again Before Running Checks** to withdraw approval. Text from the repository and tool output are treated as untrusted input to the model.

## Roadmap

- [x] **Foundation:** extension scaffold, strict TypeScript, unit tests, CI
- [x] **Context filter:** decide which files may be shared, with a reason for each exclusion
- [ ] **Code navigation:** find the files and symbols relevant to a goal
- [x] **Tutoring policy:** checkpoint state machine, hint ladder, locked reveals, session summary
- [x] **Mentor loop:** Claude-backed planner and hints, chat panel
- [x] **Feedback:** run the type checker and tests with consent, list errors, explain them without the fix
- [ ] **Independent check:** unassisted task, session recap, local learning log
- [ ] **Pilot metrics (opt-in):** hints per checkpoint, checkpoint completion, return sessions
- [ ] **Pilot:** 20 developers on their own repositories, compared with Claude Code's Learning mode
- [ ] **Later:** voice, more languages, an instructor view for courses and bootcamps

## Pilot

The question the pilot answers: after a session, can someone complete a related task without AI help more often than they could after using a general assistant?

What we measure:

- unassisted completion and correctness on a follow-up task, against a control group
- hints needed per checkpoint, and whether that falls across sessions
- return sessions in week 2
- willingness to pay

Who pays is a hypothesis to test. Individual learners come first because they are fastest to reach. The likelier first paying customer is a bootcamp or university course, whose instructors need AI help that doesn't do the students' work, plus evidence of who understands the material.

## Development

Requirements: Node.js 22+ and VS Code 1.95+.

```sh
npm install
npm run watch      # rebuild on change
```

Press <kbd>F5</kbd> in VS Code to open an Extension Development Host with BuildWise loaded.

| Command | |
| --- | --- |
| `npm test` | unit tests (Vitest) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | production bundle in `dist/` |

### Layout

```text
src/core/        editor-independent logic; importing `vscode` here is a lint error
src/extension/   VS Code adapter: commands, workspace access, UI
```

Keeping the teaching logic out of the editor layer means it can be tested without VS Code and reused if BuildWise moves to another editor.

## License

No license yet. All rights reserved.
