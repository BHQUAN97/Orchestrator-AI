# AI Orchestrator

Multi-model AI agent orchestration system with **Tech Lead review**, **decision locking**, **escalation handling**, and **structured context normalization**.

Automatically routes tasks to the optimal model: Kimi K2.5 (frontend), DeepSeek (backend), Gemini Flash (review), Claude Sonnet (architecture) — reducing token cost by 70-95% compared to using a single premium model for everything.

## Architecture

```
User Request
     |
  Dispatcher (Gemini Flash — cheapest)
     |
     v
  Execution Plan (subtasks + model assignment)
     |
  Tech Lead (Claude Sonnet) ← review/approve/modify plan
     |                        ← handle escalations from dev agents
     v
  Context Manager ← normalize context to structured JSON
     |               every model receives the SAME context
     v
  +----------+----------+----------+
  |          |          |          |
FE Dev    BE Dev    Reviewer   Debugger
(Kimi)   (DeepSeek) (Gemini)  (Sonnet)
  |          |          |          |
  +----------+----------+----------+
     |
  Decision Lock ← lock API contracts, DB schemas, auth flows
     |              agents cannot override locked decisions
     v
  Synthesizer (Gemini Flash) ← merge all results
     |
     v
  Final Output
```

## Key Features

### Multi-Model Routing
Each agent role maps to the most cost-effective model for its specialty:

| Agent Role | Model | Cost/1M tokens | Specialty |
|---|---|---|---|
| `dispatcher` | Gemini Flash | $0.15 | Task analysis, result synthesis |
| `fe-dev` | Kimi K2.5 | $1.00 | React, Next.js, Vue, CSS, Tailwind |
| `be-dev` | DeepSeek | $0.27 | NestJS, Express, DB, SQL, API |
| `reviewer` | Gemini Flash | $0.15 | Code review, OWASP scan |
| `tech-lead` | Claude Sonnet | $3.00 | Architecture, plan review, escalation |
| `debugger` | Claude Sonnet | $3.00 | Complex multi-file debugging |
| `docs` | DeepSeek | $0.27 | Documentation, JSDoc, README |

### Tech Lead Agent
Claude Sonnet acts as Tech Lead — reviews execution plans before dev agents run:
- **Quick review** (free, no API call): catches model misassignment, circular deps, oversized tasks
- **Full review** (API call): deep analysis when quick review finds multiple issues
- **Escalation handler**: when dev agents get stuck, Tech Lead provides guidance

### Decision Locking
Prevents agents from overriding each other's decisions:
- Tech Lead locks critical decisions (API contracts, DB schemas, auth flows)
- Dev agents receive locked decisions in their context
- Attempting to modify a locked scope triggers automatic escalation

### Escalation System
Dev agents automatically escalate to Tech Lead when:
1. Analysis takes too long without a clear solution
2. Need to change API contract or database schema
3. Bug spans > 3 files with unclear root cause
4. Conflict with a locked decision
5. Architecture change needed
6. Security implications unclear

Tech Lead responds with one of:
- **GUIDE**: Provide specific direction, agent retries (preferred, cheapest)
- **REDIRECT**: Switch to a different model/agent better suited
- **TAKE_OVER**: Tech Lead handles it directly (rare, expensive)

### Context Normalization
All agents receive context as structured JSON — not free-form text:
- Every model parses the same data structure identically
- Includes: project metadata, task info, locked decisions, spec/plan, previous results
- Output normalization: standardizes results before passing to next agent

## Project Structure

```
ai-orchestrator/
|-- .env.example              # API keys template (copy to .env)
|-- .gitignore
|-- docker-compose.yaml       # All services
|-- litellm_config.yaml       # Model routing + fallback + budget
|-- hermes_config.yaml        # Hermes agent config
|-- model-routing-map.md      # Task-to-model mapping reference
|
|-- router/                   # Core orchestration modules
|   |-- orchestrator-agent.js # Main flow: plan -> review -> execute -> escalation
|   |-- smart-router.js       # Score-based model selection
|   |-- context-manager.js    # Structured context injection + normalization
|   |-- decision-lock.js      # Decision registry (lock/unlock/validate)
|   |-- tech-lead-agent.js    # Tech Lead: review, approve, escalation
|   +-- test-router.js        # Tests
|
|-- prompts/                  # Agent prompt templates
|   |-- tech-lead.md
|   |-- fe-dev.md
|   |-- be-dev.md
|   |-- reviewer.md
|   +-- debugger.md
|
|-- graph/                    # Trust Graph (context reduction)
|   |-- trust-graph.js        # Build dependency graph
|   |-- query.js              # Query related files
|   +-- watcher.js            # Auto-reindex on file change
|
|-- cache/                    # Context caching
|   +-- context-cache.js      # LRU cache with file-hash invalidation
|
|-- analytics/                # Cost tracking
|   |-- tracker.js
|   |-- api-server.js
|   +-- dashboard.html
|
|-- dashboard/                # Web dashboard
|   |-- index.html
|   +-- serve.js
|
|-- skills/                   # Hermes agent skills
|-- docs/                     # Documentation
|-- .roomodes                 # Roo Code custom modes (7 modes)
+-- .roo/rules/               # Roo Code rules per mode
```

## Setup

### Prerequisites
- Docker Desktop
- Node.js 18+
- Git

### Step 1: Clone and configure

```bash
git clone https://github.com/BHQUAN97/Orchestrator-AI.git
cd Orchestrator-AI

# Copy env template
cp .env.example .env
```

### Step 2: Get API keys

You need at least ONE provider key. **OpenRouter** is recommended (1 key = 200+ models):

| Provider | Sign up | Free tier |
|---|---|---|
| **OpenRouter** (recommended) | https://openrouter.ai/keys | $5 free credit |
| Google Gemini | https://aistudio.google.com/apikey | Yes |
| DeepSeek | https://platform.deepseek.com/api_keys | Yes |
| Moonshot (Kimi) | https://platform.moonshot.cn/console/api-keys | Yes |
| Anthropic (Sonnet) | https://console.anthropic.com/settings/keys | No |

### Step 3: Edit `.env`

```bash
# Required: at least one
OPENROUTER_API_KEY=your-key-here
GEMINI_API_KEY=your-key-here

# Optional: direct provider keys (bypass OpenRouter for lower latency)
DEEPSEEK_API_KEY=your-key-here
KIMI_API_KEY=your-key-here
ANTHROPIC_API_KEY=your-key-here

# LiteLLM proxy key (change this for security)
LITELLM_MASTER_KEY=your-custom-master-key
```

### Step 4: Start services

```bash
docker compose up -d

# Verify
docker compose ps
docker compose logs -f
```

### Step 5: Verify

| Service | URL | Check |
|---|---|---|
| LiteLLM Proxy | http://localhost:4001/health | `{"status": "healthy"}` |
| LiteLLM UI | http://localhost:4001/ui | Dashboard loads |
| Dashboard | http://localhost:8080 | Overview page |

## Usage

### Via Orchestrator (Node.js)

```javascript
const { OrchestratorAgent } = require('./router/orchestrator-agent');

const orchestrator = new OrchestratorAgent({
  projectDir: '/path/to/your/project',
  litellmUrl: 'http://localhost:4001',
  litellmKey: process.env.LITELLM_MASTER_KEY
});

// Full flow: plan -> tech lead review -> execute -> synthesize
const result = await orchestrator.run('Build login page with JWT auth', {
  files: ['src/auth/login.tsx', 'src/api/auth.service.ts'],
  task: 'build'
});

console.log(result.summary);
console.log(`Models used: ${result.models_used.join(', ')}`);
console.log(`Escalations: ${result.escalations.length}`);
```

### Via CLI

```bash
# Simple task (auto-routes to best model)
node -e "
  const { OrchestratorAgent } = require('./router/orchestrator-agent');
  const o = new OrchestratorAgent({ litellmKey: process.env.LITELLM_MASTER_KEY });
  o.run('review auth module for security issues', { task: 'review' })
   .then(r => console.log(r.summary));
"
```

### Via LiteLLM API directly

```bash
curl http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Model names: `default` (Kimi), `smart` (Sonnet), `fast` (Gemini), `cheap` (DeepSeek)

### With Roo Code (VS Code)

This project includes 7 custom Roo Code modes with escalation rules:

| Mode | Role | Escalation |
|---|---|---|
| `tech-lead` | Review plans, approve decisions | N/A (top of chain) |
| `spec` | Write specifications | - |
| `build` | Implement features | -> tech-lead when stuck |
| `review` | Code review, security audit | -> tech-lead on Critical findings |
| `debug` | Debug and fix bugs | -> tech-lead on complex bugs |
| `docs` | Write documentation | - |
| `seed` | Generate test data | - |

## Model Routing

### How the Smart Router works

The router scores each model based on 5 factors:
1. **Task match** (40%): task type strengths alignment
2. **File domain** (25%): frontend/backend/database file detection
3. **Keywords** (20%): prompt keyword analysis
4. **Context size** (constraint): penalize if context exceeds model limit
5. **Cost** (10%): bonus for cheaper models

### Fallback chain (automatic via LiteLLM)

```
default:  Kimi K2.5 -> OpenRouter/Kimi -> DeepSeek
smart:    Sonnet 4  -> OpenRouter/Sonnet -> Kimi K2.5
fast:     Gemini Flash -> OpenRouter/Gemini -> DeepSeek
cheap:    DeepSeek -> OpenRouter/DeepSeek -> Gemini Flash
```

## Configuration

### Budget control

In `litellm_config.yaml`:
```yaml
general_settings:
  max_budget: 5.0        # Max $5 per day
  budget_duration: "1d"
```

### Add a new model

1. Add to `litellm_config.yaml`:
```yaml
- model_name: "my-model"
  litellm_params:
    model: "provider/model-name"
    api_key: "os.environ/MY_MODEL_KEY"
```

2. Add profile to `router/smart-router.js` in `MODEL_PROFILES`

3. Restart: `docker compose restart litellm`

## Troubleshooting

**LiteLLM won't start:**
```bash
docker compose logs litellm
# Common: YAML syntax error, missing env var
```

**Model returns errors:**
```bash
# Check if key is set
docker compose exec litellm env | grep API_KEY
# Test specific model
curl http://localhost:4001/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

**Escalation loops:**
- Check `MAX_ESCALATIONS_PER_TASK` in orchestrator-agent.js (default: 3)
- Review escalation history: `orchestrator.techLead.getStats()`

## License

MIT
