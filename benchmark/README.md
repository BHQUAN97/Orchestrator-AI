# Benchmark Harness

> Chay test E2E cho OrcAI voi nhieu task + nhieu model. Doc `docs/BENCHMARK-PLAN.md` truoc.

## Cau truc

```
benchmark/
  tasks.json       # dinh nghia task (id, prompt, verify)
  verify.js        # logic pass/fail cho tung task
  runner.js        # chay 1 task x model, log JSONL
  scorer.js        # aggregate JSONL -> markdown report
  fixtures/        # (sau nay) snapshot project cho isolated test
  results/         # output JSONL + report
```

## Pre-flight checklist

Truoc khi chay:
- [ ] `.env` co API key hop le
- [ ] LiteLLM proxy dang chay (`curl http://localhost:5002/health`)
- [ ] Budget daily > $5
- [ ] Repo clean state (`git status` empty) — fixture copy dung working tree

## Usage

### Dry run (kiem tra setup)
```bash
node benchmark/runner.js --tier A --model default --dry-run
```

### Chay 1 task voi 1 model
```bash
node benchmark/runner.js --task T01 --model default
```

### Chay tat ca A-tier voi 3 model
```bash
node benchmark/runner.js --tier A --model default,cheap,smart
```

### Chay ALL task x ALL model (full run)
```bash
node benchmark/runner.js --all --model default,cheap,smart,fast
```

### Generate report
```bash
node benchmark/scorer.js benchmark/results/2026-04-18-abc.jsonl
```

## Safety

- Moi task chay trong **temp dir** (os.tmpdir), KHONG cham main codebase
- Timeout 60-180s per task, kill SIGKILL neu treo
- Budget cap per task (task.budget_usd) + overall session cap
- Auto-cleanup fixture sau moi run

## Model aliases (Updated 2026-04-18)

| Alias | Maps to | Khi nao dung |
|---|---|---|
| `architect` | DeepSeek V4 Pro | Architecture, task cuc kho, logic phuc tap |
| `default` | DeepSeek V4 Flash | Task thuong, viet code, toc do cao |
| `cheap` | GPT-5.4 Mini | Task BE, SQL, API, Review |
| `smart` | Gemini 3 Flash | Multi-file debug, reasoning nhanh |
| `fast` | Gemini 3 Flash | Review, scan, tom tat |
| `opus-legacy`| Claude Opus 4.6 | Du phong khi V4 Pro fail |
