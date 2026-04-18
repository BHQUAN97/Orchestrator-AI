# Benchmark Report

- Generated: 2026-04-18T07:30:40.666Z
- Total runs: 20
- Unique tasks: 5
- Models tested: gemini, default, cheap, smart

## Pass rate by model

| Model | Pass | Total | % | Avg wall_ms | Avg cost_usd |
|---|---|---|---|---|---|
| gemini | 3 | 5 | 60% | 53035 | — |
| default | 2 | 5 | 40% | 33214 | — |
| cheap | 4 | 5 | 80% | 7380 | — |
| smart | 2 | 5 | 40% | 3632 | — |

## Pass rate by tier

| Tier | Pass | Total | % |
|---|---|---|---|
| A | 11 | 20 | 55% |

## Detail per task

| Task | Title | Model | Result | Wall ms | Reason |
|---|---|---|---|---|---|
| T01 | Count async functions | gemini | FAIL | 60031 | no match for \b([0-9]+)\s*async |
| T01 | Count async functions | default | FAIL | 2385 | no match for \b([0-9]+)\s*async |
| T02 | Add JSDoc to runPlanFlow | gemini | PASS | 65076 |  |
| T02 | Add JSDoc to runPlanFlow | default | PASS | 45394 |  |
| T03 | Rename variable in test file | gemini | PASS | 90084 |  |
| T03 | Rename variable in test file | default | FAIL | 42038 | pattern not found in test/parity.test.js |
| T04 | Find typo in README | gemini | PASS | 22772 |  |
| T04 | Find typo in README | default | PASS | 29034 |  |
| T05 | List tools registered in definitions | gemini | FAIL | 27210 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T05 | List tools registered in definitions | default | FAIL | 47220 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
| T01 | Count async functions | cheap | FAIL | 5801 | no match for \b([0-9]+)\s*async |
| T01 | Count async functions | smart | FAIL | 991 | no match for \b([0-9]+)\s*async |
| T02 | Add JSDoc to runPlanFlow | cheap | PASS | 6500 |  |
| T02 | Add JSDoc to runPlanFlow | smart | PASS | 8699 |  |
| T03 | Rename variable in test file | cheap | PASS | 11236 |  |
| T03 | Rename variable in test file | smart | FAIL | 953 | pattern not found in test/parity.test.js |
| T04 | Find typo in README | cheap | PASS | 5312 |  |
| T04 | Find typo in README | smart | PASS | 6583 |  |
| T05 | List tools registered in definitions | cheap | PASS | 8051 |  |
| T05 | List tools registered in definitions | smart | FAIL | 933 | no match for read_file[\s\S]*write_file[\s\S]*execute_command |
