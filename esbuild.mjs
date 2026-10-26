import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/extension/index.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    // Provided by the VS Code runtime, never bundled.
    external: ['vscode'],
  }),
  esbuild.context({
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
