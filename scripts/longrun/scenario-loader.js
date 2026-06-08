const fs = require('fs');
const path = require('path');

const SCENARIO_DIR = path.join(__dirname, 'scenarios');

function loadScenario(nameOrPath) {
  const file = nameOrPath.endsWith('.json')
    ? nameOrPath
    : path.join(SCENARIO_DIR, `${nameOrPath}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`scenario not found: ${nameOrPath}`);
  }
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  scenario._file = file;
  return scenario;
}

function listScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
}

module.exports = {
  loadScenario,
  listScenarios,
  SCENARIO_DIR,
};
