# Direct Tmux Workflow System

A minimal, efficient workflow automation system using direct tmux operations.

## Core Files

- **`tmux_utils.js`** - Direct tmux operations (send, read, list instances)
- **`task_chain_launcher.js`** - Main workflow executor 
- **`chain_keyword_monitor.js`** - Keyword detection and automatic chaining
- **`quick_task.js`** - User-friendly task runner interface
- **`shared/workflow_utils.js`** - Shared utilities and helpers

## Workflow System

### Predefined Workflows
The system includes several predefined workflows in the `workflows/` directory:
- **`default.json`** - Standard development workflow: implement → test → document → finalize
- **`debug.json`** - Debugging workflow: reproduce → diagnose → fix → verify
- **`review.json`** - Code review workflow: analyze → refactor → test → commit
- **`phase.json`** - Phase implementation workflow: execute → compare → deduplicate → cleanup

## Usage

### Quick Start
```bash
node quick_task.js "Your task description here"
```

### With Custom Workflow
```bash
node quick_task.js "Create a login system" --preset debug
node quick_task.js "Refactor auth module" --stages analyze,plan,implement,test
```

### Direct Chain Launcher
```bash
node task_chain_launcher.js simple_task_progression.json [instanceId]
```

## Configuration Examples

- **`simple_task_progression.json`** - Basic task progression config
- **`phase_implementation_workflow.json`** - Advanced phase-based workflow

## Requirements

- Node.js (ES modules support)
- tmux installed and available in PATH
- Claude instances running in tmux sessions named `claude_<instanceId>`

## Creating Custom Workflows

To create a custom workflow:

1. Create a new JSON file in the `workflows/` directory
2. Follow the workflow schema (see `workflow-schema.json` for reference)
3. Define your workflow stages with keywords and instructions

### Example Custom Workflow
```json
{
  "name": "custom",
  "description": "My custom workflow for specific tasks",
  "chains": [
    {
      "keyword": "PLANNED",
      "instruction": "Now implement the plan for '{{TASK}}'. End by saying BUILT",
      "nextKeyword": "BUILT"
    },
    {
      "keyword": "BUILT",
      "instruction": "Test the implementation. End by saying VERIFIED",
      "nextKeyword": "VERIFIED"
    },
    {
      "keyword": "VERIFIED",
      "instruction": "Great work! Task '{{TASK}}' is complete!"
    }
  ],
  "initialPrompt": "Plan the approach for '{{TASK}}'. When done planning, say PLANNED",
  "options": {
    "pollInterval": 5,
    "timeout": 900,
    "retryAttempts": 3,
    "retryDelay": 2
  }
}
```

### Using Custom Workflows
Once created, your workflow will be automatically discovered:
```bash
node quick_task.js "Your task" --preset custom
```

### Template Placeholders
- `{{TASK}}` - Will be replaced with the actual task description
- Add your own placeholders and pass them via the config

## Architecture

This system eliminates MCP bridge abstractions in favor of direct tmux operations:
- `tmux send-keys` for sending commands
- `tmux capture-pane` for reading output  
- `tmux list-sessions` for instance discovery

Zero dependencies beyond Node.js standard library and tmux.