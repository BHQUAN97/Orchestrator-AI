# Benchmark Report

- Generated: 2026-04-18T09:33:06.286Z
- Total runs: 20
- Unique tasks: 5
- Models tested: free-nemotron-super, free-nemotron-nano, free-gemma4-31b, free-gemma4-26b

## Pass rate + P/P (Price/Performance) by model

P/P score = pass_rate / avg_cost — cao hon = hieu qua hon (pass nhieu voi gia re).

| Model | Pass | Total | % | Avg wall_ms | Avg cost_usd | Cost-per-Pass | P/P score |
|---|---|---|---|---|---|---|---|
| free-nemotron-nano | 4 | 5 | 80% | 16713 | $0.0552 | $0.0690 | 14.5 |
| free-nemotron-super | 4 | 5 | 80% | 52901 | $0.0606 | $0.0455 | 13.2 |
| free-gemma4-31b | 2 | 5 | 40% | 78032 | — | — | — |
| free-gemma4-26b | 2 | 5 | 40% | 78059 | — | — | — |

**Cost-per-Pass** = tong cost / so task pass (cang thap cang re). **P/P score** = pass_rate / avg_cost (cao = hieu qua).

## Pass rate by tier

| Tier | Pass | Total | % |
|---|---|---|---|
| A | 12 | 20 | 60% |

## Detail per task

| Task | Title | Model | Result | Wall ms | Reason |
|---|---|---|---|---|---|
| T01 | Count async functions | free-nemotron-super | PASS | 20185 |  |
| T01 | Count async functions | free-nemotron-nano | PASS | 10494 |  |
| T01 | Count async functions | free-gemma4-31b | FAIL | 60026 | no match for ASYNC_COUNT\s*=\s*([0-9]+) |
| T01 | Count async functions | free-gemma4-26b | FAIL | 60047 | no match for ASYNC_COUNT\s*=\s*([0-9]+) |
| T02 | Add JSDoc to runPlanFlow | free-nemotron-super | PASS | 57701 |  |
| T02 | Add JSDoc to runPlanFlow | free-nemotron-nano | PASS | 15044 |  |
| T02 | Add JSDoc to runPlanFlow | free-gemma4-31b | PASS | 90037 |  |
| T02 | Add JSDoc to runPlanFlow | free-gemma4-26b | PASS | 90128 |  |
| T03 | Rename variable in test file | free-nemotron-super | PASS | 66537 |  |
| T03 | Rename variable in test file | free-nemotron-nano | PASS | 20701 |  |
| T03 | Rename variable in test file | free-gemma4-31b | FAIL | 120041 | pattern not found in test/parity.test.js |
| T03 | Rename variable in test file | free-gemma4-26b | FAIL | 120066 | pattern not found in test/parity.test.js |
| T04 | Find typo in README | free-nemotron-super | PASS | 60043 |  |
| T04 | Find typo in README | free-nemotron-nano | PASS | 20048 |  |
| T04 | Find typo in README | free-gemma4-31b | PASS | 60025 |  |
| T04 | Find typo in README | free-gemma4-26b | PASS | 60028 |  |
| T05 | List tools registered in definitions | free-nemotron-super | FAIL | 60040 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T05 | List tools registered in definitions | free-nemotron-nano | FAIL | 17276 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T05 | List tools registered in definitions | free-gemma4-31b | FAIL | 60030 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T05 | List tools registered in definitions | free-gemma4-26b | FAIL | 60028 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
