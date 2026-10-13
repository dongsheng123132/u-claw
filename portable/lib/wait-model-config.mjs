import { setTimeout } from 'node:timers/promises';
import { isModelConfigured } from './check-model-configured.mjs';

// The first-run page saves before Gateway starts, avoiding concurrent migrations.
const deadline = Date.now() + 30 * 60 * 1000;
let configured = false;
while (Date.now() < deadline) {
  configured = isModelConfigured(process.argv[2]);
  if (configured) break;
  await setTimeout(750);
}
if (!configured) {
  console.error('Model setup timed out. Run Windows-Start.bat again to continue.');
  process.exitCode = 1;
}
