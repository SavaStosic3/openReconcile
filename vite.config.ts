import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';
import { readExecutionProfile } from './scripts/execution-profile.mjs';
import { sites } from './build/sites-vite-plugin';

export default defineConfig(async () => {
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false';
  process.env.WRANGLER_SEND_METRICS ??= 'false';
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.WRANGLER_REGISTRY_PATH ??= '.wrangler/dev-registry';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    server: { host: '127.0.0.1' },
    plugins: [vinext(), sites({ mockAuth: readExecutionProfile() !== 'managed-linux' }), cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      inspectorPort: false,
      config: {
        main: './build/sites-worker.ts',
        // Highest date supported by the starter's pinned local Workers runtime.
        compatibility_date: '2026-05-22',
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, traces: { enabled: true } },
        d1_databases: [{ binding: hostingConfig.d1, database_name: 'openreconcile', database_id: '00000000-0000-4000-8000-000000000000', migrations_dir: 'drizzle' }]
      }
    })]
  };
});
