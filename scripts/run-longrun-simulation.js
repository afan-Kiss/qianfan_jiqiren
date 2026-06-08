const path = require('path');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { loadScenario, listScenarios } = require('./longrun/scenario-loader');

function parseArgs(argv = []) {
  const args = { scenario: 'smoke-1day', cleanup: true, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scenario') args.scenario = argv[i + 1];
    if (argv[i] === '--no-cleanup') args.cleanup = false;
    if (argv[i] === '--strict') args.strict = true;
    if (argv[i] === '--help') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/run-longrun-simulation.js --scenario <name>');
    console.log(`Scenarios: ${listScenarios().join(', ')}`);
    process.exit(0);
  }

  const scenario = loadScenario(args.scenario);
  const harness = new LongrunHarness({
    runId: `${scenario.name}-${Date.now()}`,
    seed: scenario.seed,
    injectDelayMs: scenario.name === 'smoke-1day' ? 35 : 15,
    leakOptions: { strict: args.strict },
  });

  try {
    await harness.start();
    const result = await harness.runScenario(scenario);
    await harness.stop();

    console.log(`[longrun] scenario=${scenario.name} passed=${result.passed}`);
    console.log(`[longrun] report=${path.join(harness.reportDir, 'summary.md')}`);
    if (!result.passed) {
      console.error('[longrun] invariant failures:', result.metrics.invariantFailures);
      process.exit(1);
    }
  } finally {
    if (args.cleanup) await harness.cleanup(true);
    else await harness.cleanup(false);
  }
}

main().catch((err) => {
  console.error('[run-longrun-simulation] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
