# Direct Tmux Workflow System

A minimal, efficient workflow automation system using direct tmux operations.

## Core Files

- **`tmux_utils.js`** - Direct tmux operations (send, read, list instances)
- **`task_chain_launcher.js`** - Main workflow executor 
- **`chain_keyword_monitor.js`** - Keyword detection and automatic chaining
- **`quick_task.js`** - User-friendly task runner interface
- **`shared/workflow_utils.js`** - Shared utilities and helpers

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

## Architecture

This system eliminates MCP bridge abstractions in favor of direct tmux operations:
- `tmux send-keys` for sending commands
- `tmux capture-pane` for reading output  
- `tmux list-sessions` for instance discovery

Zero dependencies beyond Node.js standard library and tmux.