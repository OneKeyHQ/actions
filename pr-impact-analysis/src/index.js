const core = require('@actions/core');

async function run() {
  try {
    core.info('PR Impact Analysis started');
    // TODO: implement
    core.info('PR Impact Analysis completed');
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
