const { HermesBridge } = require('./lib/hermes-bridge');
const { MemoryStore } = require('./lib/memory');
const fs = require('fs');
const path = require('path');

async function testIntelligence() {
  console.log("--- Testing AI Intelligence & Context Injection ---");
  
  const projectDir = process.cwd();
  const bridge = new HermesBridge({ projectDir });
  const memoryStore = new MemoryStore(projectDir);

  // 1. Test: Memory Injection
  console.log("\n[Test 1] Memory Injection");
  const testMemory = {
    type: 'gotcha',
    summary: 'Always use port 5002 for LiteLLM in this project.',
    keywords: ['litellm', 'port', '5002']
  };
  memoryStore.append(testMemory);
  
  const memories = await bridge.getRelevantMemories('What port should I use for LiteLLM?');
  const formattedMemories = bridge.formatMemoriesForPrompt(memories);
  
  if (formattedMemories.includes('5002')) {
    console.log("✅ SUCCESS: Memory injected into prompt context.");
  } else {
    console.log("❌ FAILURE: Memory NOT found in prompt context.");
  }

  // 2. Test: Decision Lock Injection
  console.log("\n[Test 2] Decision Lock Injection");
  const formattedLocks = bridge.formatLocksForPrompt();
  if (formattedLocks.includes('Freeze Auth API') && formattedLocks.includes('lib/auth-test.js')) {
    console.log("✅ SUCCESS: Active locks injected into prompt context.");
  } else {
    console.log("❌ FAILURE: Active locks NOT found in prompt context.");
  }

  // 3. Test: Path Heuristic Intelligence
  console.log("\n[Test 3] Path Heuristic Intelligence");
  
  bridge.decisionLock.lock({
    decision: 'Use JWT for all API endpoints',
    scope: 'api',
    approvedBy: 'tech-lead',
    ttl: 3600000
  });

  // 4. Test: Expanded Path Heuristic
  console.log("\n[Test 4] Expanded Path Heuristic");
  const testCases = [
    { path: 'src/routes/admin.js', expected: 'api' },
    { path: 'lib/repositories/userRepo.js', expected: 'database' },
    { path: 'src/entities/Product.ts', expected: 'schema' },
    { path: 'tests/unit/auth.spec.js', expected: 'testing' }
  ];

  for (const tc of testCases) {
    // We need locks for these scopes to test detection
    bridge.decisionLock.lock({
      decision: `Lock for ${tc.expected}`,
      scope: tc.expected,
      approvedBy: 'tech-lead',
      ttl: 3600000
    });

    const detected = bridge.checkFilePath(tc.path);
    if (detected.some(l => l.scope === tc.expected)) {
      console.log(`✅ SUCCESS: Detected '${tc.expected}' for path '${tc.path}'`);
    } else {
      console.log(`❌ FAILURE: Failed to detect '${tc.expected}' for path '${tc.path}'`);
    }
  }
}

testIntelligence().catch(console.error);
