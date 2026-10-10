import { loadConfig } from './config.js';
import { createGateway } from './gateway.js';

try {
  const config = loadConfig();
  const gateway = createGateway(config);
  gateway.server.listen(config.port, config.host, () => {
    console.log(`openReconcile SQL gateway listening on ${config.host}:${config.port}`);
  });
  gateway.server.on('error', () => { console.error('The SQL gateway could not listen on its configured address.'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    await gateway.close();
    clearTimeout(timer);
  });
} catch (error) {
  console.error(error.code === 'INVALID_CONFIG' ? error.message : 'The SQL gateway could not start.');
  process.exitCode = 1;
}
