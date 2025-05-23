const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        result.errors.forEach(({ text, location }) => {
          console.error(`✘ [ERROR] ${text}`);
          if (location) {
            console.error(`    ${location.file}:${location.line}:${location.column}:`);
          }
        });
      }
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  try {
    const ctx = await esbuild.context({
      entryPoints: ['src/extension.ts'],
      bundle: true,
      format: 'cjs',
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      platform: 'node',
      outfile: 'dist/extension.js',
      external: ['vscode'],
      logLevel: 'info',
      plugins: [esbuildProblemMatcherPlugin],
    });

    if (watch) {
      await ctx.watch();
      console.log('Watching...');
    } else {
      await ctx.rebuild();
      await ctx.dispose();
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
