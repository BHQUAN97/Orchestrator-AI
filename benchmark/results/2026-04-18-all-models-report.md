# Benchmark Report

- Generated: 2026-04-18T08:45:07.259Z
- Total runs: 30
- Unique tasks: 5
- Models tested: fast-or, default, cheap, smart, free-minimax, free-glm

## Pass rate + P/P (Price/Performance) by model

P/P score = pass_rate / avg_cost — cao hon = hieu qua hon (pass nhieu voi gia re).

| Model | Pass | Total | % | Avg wall_ms | Avg cost_usd | Cost-per-Pass | P/P score |
|---|---|---|---|---|---|---|---|
| cheap | 5 | 5 | 100% | 7376 | $0.0089 | $0.0089 | 112.4 |
| fast-or | 5 | 5 | 100% | 10790 | $0.0445 | $0.0445 | 22.5 |
| free-glm | 3 | 5 | 60% | 64379 | $0.0612 | $0.0816 | 9.8 |
| default | 2 | 5 | 40% | 56464 | $0.0696 | $0.1045 | 5.7 |
| smart | 3 | 5 | 60% | 10350 | $0.1220 | $0.2033 | 4.9 |
| free-minimax | 2 | 5 | 40% | 65793 | — | — | — |

**Cost-per-Pass** = tong cost / so task pass (cang thap cang re). **P/P score** = pass_rate / avg_cost (cao = hieu qua).

## Pass rate by tier

| Tier | Pass | Total | % |
|---|---|---|---|
| A | 20 | 30 | 67% |

## Detail per task

| Task | Title | Model | Result | Wall ms | Reason |
|---|---|---|---|---|---|
| T01 | Count async functions | fast-or | PASS | 6159 |  |
| T01 | Count async functions | default | FAIL | 60034 | no match for ASYNC_COUNT\s*=\s*([0-9]+) |
| T01 | Count async functions | cheap | PASS | 6027 |  |
| T01 | Count async functions | smart | PASS | 8366 |  |
| T02 | Add JSDoc to runPlanFlow | fast-or | PASS | 9137 |  |
| T02 | Add JSDoc to runPlanFlow | default | PASS | 52774 |  |
| T02 | Add JSDoc to runPlanFlow | cheap | PASS | 6274 |  |
| T02 | Add JSDoc to runPlanFlow | smart | PASS | 11918 |  |
| T03 | Rename variable in test file | fast-or | PASS | 18189 |  |
| T03 | Rename variable in test file | default | FAIL | 61232 | pattern not found in test/parity.test.js |
| T03 | Rename variable in test file | cheap | PASS | 11701 |  |
| T03 | Rename variable in test file | smart | FAIL | 7429 | pattern not found in test/parity.test.js |
| T04 | Find typo in README | fast-or | PASS | 6322 |  |
| T04 | Find typo in README | default | PASS | 48230 |  |
| T04 | Find typo in README | cheap | PASS | 7035 |  |
| T04 | Find typo in README | smart | PASS | 12127 |  |
| T05 | List tools registered in definitions | fast-or | PASS | 14142 |  |
| T05 | List tools registered in definitions | default | FAIL | 60050 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T05 | List tools registered in definitions | cheap | PASS | 5843 |  |
| T05 | List tools registered in definitions | smart | FAIL | 11909 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T01 | Count async functions | free-minimax | FAIL | 60145 | no match for ASYNC_COUNT\s*=\s*([0-9]+) |
| T01 | Count async functions | free-glm | FAIL | 60069 | no match for ASYNC_COUNT\s*=\s*([0-9]+) |
| T02 | Add JSDoc to runPlanFlow | free-minimax | PASS | 90056 |  |
| T02 | Add JSDoc to runPlanFlow | free-glm | PASS | 47520 |  |
| T03 | Rename variable in test file | free-minimax | FAIL | 120053 | pattern not found in test/parity.test.js |
| T03 | Rename variable in test file | free-glm | FAIL | 115732 | pattern not found in test/parity.test.js |
| T04 | Find typo in README | free-minimax | PASS | 16901 |  |
| T04 | Find typo in README | free-glm | PASS | 39379 |  |
| T05 | List tools registered in definitions | free-minimax | FAIL | 41811 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T05 | List tools registered in definitions | free-glm | PASS | 59194 |  |
