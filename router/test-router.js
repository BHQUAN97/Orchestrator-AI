#!/usr/bin/env node
/**
 * Test Smart Router + Orchestrator Agent
 * Chay: node test-router.js
 */

const { SmartRouter } = require('./smart-router');
const { OrchestratorAgent } = require('./orchestrator-agent');

// === Test Smart Router ===
console.log('=== Smart Router Tests ===\n');

const router = new SmartRouter({
  availableModels: ['gemini-flash', 'kimi-k2.5', 'deepseek', 'sonnet'],
  costOptimize: true
});

const tests = [
  {
    name: 'Fix FE component',
    params: {
      task: 'fix',
      files: ['frontend/src/components/ProductCard.tsx', 'frontend/src/styles/product.css'],
      prompt: 'Fix responsive layout cho ProductCard tren mobile',
      project: 'FashionEcom'
    }
  },
  {
    name: 'Build BE API',
    params: {
      task: 'build',
      files: ['backend/src/modules/order/order.service.ts', 'backend/src/modules/order/order.controller.ts'],
      prompt: 'Them API endpoint tao don hang moi',
      project: 'FashionEcom'
    }
  },
  {
    name: 'Spec feature moi',
    params: {
      task: 'spec',
      files: [],
      prompt: 'Thiet ke tinh nang chat realtime giua buyer va seller',
      project: 'FashionEcom'
    }
  },
  {
    name: 'Review code',
    params: {
      task: 'review',
      files: ['backend/src/modules/auth/auth.service.ts'],
      prompt: 'Review auth service, check security va performance',
      project: 'FashionEcom'
    }
  },
  {
    name: 'Viet docs',
    params: {
      task: 'docs',
      files: ['backend/src/modules/order/order.service.ts'],
      prompt: 'Viet JSDoc cho order service',
      project: 'FashionEcom'
    }
  },
  {
    name: 'DB migration',
    params: {
      task: 'build',
      files: ['backend/src/modules/order/entities/order.entity.ts'],
      prompt: 'Tao migration them truong discount_code vao bang order',
      project: 'FashionEcom'
    }
  },
  {
    name: 'Debug complex',
    params: {
      task: 'debug',
      files: [
        'backend/src/modules/payment/payment.service.ts',
        'backend/src/modules/order/order.service.ts',
        'frontend/src/pages/checkout/index.tsx'
      ],
      prompt: 'Payment webhook khong update order status, can trace tu FE → BE → DB',
      project: 'FashionEcom'
    }
  },
  {
    name: 'UI Test',
    params: {
      task: 'ui_test',
      files: ['frontend/src/pages/product/[id].tsx'],
      prompt: 'Test trang product detail tren mobile va tablet',
      project: 'FashionEcom'
    }
  }
];

for (const test of tests) {
  const result = router.route(test.params);
  console.log(`📌 ${test.name}`);
  console.log(`   → ${result.model} (${result.litellm_name}) — score: ${result.score}`);
  console.log(`   Reasons: ${result.reasons.join(', ')}`);
  console.log(`   Cost: $${result.cost}/1M tokens`);
  if (result.alternatives.length > 0) {
    console.log(`   Alt: ${result.alternatives[0].model} (score: ${result.alternatives[0].score})`);
  }
  console.log('');
}

// === Test Orchestrator Agent (chi khi co LiteLLM) ===
async function testOrchestrator() {
  console.log('\n=== Orchestrator Agent Test ===\n');

  const agent = new OrchestratorAgent({
    litellmUrl: 'http://localhost:4001',
    litellmKey: 'sk-master-change-me',
    dispatcherModel: 'fast'  // Gemini Flash lam dispatcher
  });

  try {
    const plan = await agent.plan(
      'Them tinh nang wishlist: user co the luu san pham yeu thich. Can: API endpoint, DB entity, va FE component.',
      {
        project: 'FashionEcom',
        files: [
          'backend/src/modules/product/product.service.ts',
          'frontend/src/components/ProductCard.tsx'
        ]
      }
    );

    console.log('Plan:');
    console.log(JSON.stringify(plan, null, 2));
  } catch (err) {
    console.log(`⚠️  Orchestrator test skipped (LiteLLM not available): ${err.message}`);
  }
}

testOrchestrator().catch(console.error);
