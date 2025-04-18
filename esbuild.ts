import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const esbuildProblemMatcherPlugin: esbuild.Plugin = {
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
      } else {
        console.log('[watch] build finished');
      }
    });
  },
};

interface BuildOptions {
  production: boolean;
  watch: boolean;
}

async function createBuildContext(options: BuildOptions): Promise<esbuild.BuildContext> {
  return await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: options.production,
    sourcemap: !options.production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    plugins: [esbuildProblemMatcherPlugin],
  });
}

async function main() {
  try {
    const ctx = await createBuildContext({ production, watch });

    if (watch) {
      await ctx.watch();
      console.log('[watch] build finished');
      console.log('Watching...');
    } else {
      await ctx.rebuild();
      await ctx.dispose();
    }
  } catch (err) {
    console.error('Build failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
