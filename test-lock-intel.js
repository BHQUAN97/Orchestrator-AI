const { HermesBridge } = require('./lib/hermes-bridge');
const path = require('path');

async function testLockIntelligence() {
  console.log("--- Testing Decision Lock Intelligence ---");
  
  const bridge = new HermesBridge({ projectDir: process.cwd() });
  const targetFile = 'lib/auth-test.js';
  
  console.log(`Checking if '${targetFile}' is locked...`);
  const locks = bridge.checkFilePath(targetFile);
  
  if (locks.length > 0) {
    console.log("SUCCESS: System detected the lock!");
    locks.forEach(l => {
      console.log(`[LOCK FOUND] ID: ${l.id}, Reason: ${l.reason}, Scope: ${l.scope}`);
    });
    console.log("\nIntelligence Check: If an agent tried to write to this file, it SHOULD be blocked.");
  } else {
    console.log("FAILURE: System ignored the lock. This is 'stupid' behavior.");
  }
}

testLockIntelligence().catch(console.error);
