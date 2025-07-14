#!/usr/bin/env node
/**
 * Quick Task Runner - Run a task through stages with a single command
 * 
 * Usage: 
 *   node quick_task.js "Create a function that validates email addresses"
 *   node quick_task.js "Refactor the user authentication module" --stages implement,test,document,commit
 *   node quick_task.js "Fix memory leak in image processor" --instance spec_1_1_123456
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseCommandLineArgs, replaceTemplatePlaceholders, sessionNameToInstanceId } from './shared/workflow_utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default stage progressions
const STAGE_PRESETS = {
  default: [
    { keyword: "IMPLEMENTED", nextStage: "test", nextKeyword: "TESTED" },
    { keyword: "TESTED", nextStage: "document", nextKeyword: "DOCUMENTED" },
    { keyword: "DOCUMENTED", nextStage: "finalize", nextKeyword: "COMPLETE" }
  ],
  debug: [
    { keyword: "REPRODUCED", nextStage: "diagnose", nextKeyword: "DIAGNOSED" },
    { keyword: "DIAGNOSED", nextStage: "fix", nextKeyword: "FIXED" },
    { keyword: "FIXED", nextStage: "verify", nextKeyword: "VERIFIED" }
  ],
  review: [
    { keyword: "ANALYZED", nextStage: "refactor", nextKeyword: "REFACTORED" },
    { keyword: "REFACTORED", nextStage: "test", nextKeyword: "TESTED" },
    { keyword: "TESTED", nextStage: "commit", nextKeyword: "COMMITTED" }
  ],
  phase: [
    { keyword: "EXECUTE_FINISHED", nextStage: "compare", nextKeyword: "COMPARISON FINISHED" },
    { keyword: "COMPARISON FINISHED", nextStage: "deduplicate", nextKeyword: "DUPLICATION_ELIMINATED" },
    { keyword: "DUPLICATION_ELIMINATED", nextStage: "cleanup", nextKeyword: "COMMIT_FINISHED" }
  ]
};

// Stage instructions templates
const STAGE_INSTRUCTIONS = {
  test: "Great implementation! Now test '{{TASK}}' with various inputs and edge cases. Show the test results.",
  document: "Excellent testing! Now document '{{TASK}}' with clear comments and usage examples.",
  diagnose: "Good reproduction! Now diagnose the root cause of '{{TASK}}'. Explain what's causing the issue.",
  fix: "Good diagnosis! Now implement a fix for '{{TASK}}'. Show the corrected code.",
  verify: "Good fix! Now verify that '{{TASK}}' is fully resolved. Run tests to confirm.",
  refactor: "Good analysis! Now refactor the code for '{{TASK}}' following best practices.",
  commit: "Great work! Now create a git commit for '{{TASK}}' with a clear commit message.",
  finalize: "Perfect! Now provide a final summary of '{{TASK}}' including what was done and any important notes.",
  compare: "Compare the implementation against requirements. List completed, missing, partial items and deviations.",
  deduplicate: "Eliminate all duplicated functionality. Identify semantic twins and consolidate to canonical implementations.",
  cleanup: "Clean up code, update documentation, run tests, and commit all changes."
};

function parseArgs(args) {
  const parsed = parseCommandLineArgs(args, {
    stringFlags: ['instance', 'stages', 'preset', 'session', 'name'],
    aliases: { i: 'instance', s: 'stages', p: 'preset', t: 'session', n: 'name' }
  });
  
  return {
    task: parsed.positional[0],
    instanceId: parsed.flags.instance || null,
    sessionName: parsed.flags.session || null,
    customName: parsed.flags.name || null,
    preset: parsed.flags.preset || 'default',
    customStages: parsed.flags.stages ? parsed.flags.stages.split(',') : null
  };
}

function buildChains(stages) {
  const chains = [];
  
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const instruction = STAGE_INSTRUCTIONS[stage.nextStage] || 
                       `Complete the ${stage.nextStage} phase for '{{TASK}}'. Be thorough and complete.`;
    
    chains.push({
      keyword: stage.keyword,
      instruction: instruction + ` End by saying ${stage.nextKeyword}`,
      nextKeyword: stage.nextKeyword
    });
  }
  
  // Add final completion message
  const lastKeyword = stages[stages.length - 1].nextKeyword;
  chains.push({
    keyword: lastKeyword,
    instruction: "🎉 Excellent work! You have successfully completed all stages for '{{TASK}}'. Well done!"
  });
  
  return chains;
}


async function handleNamedSession(customName) {
  // Import tmux utils
  const tmuxUtils = await import('./tmux_utils.js');
  
  // Use the exact name provided by user
  const sessionName = customName;
  const sessionExists = await tmuxUtils.sessionExists(sessionName);
  
  if (sessionExists) {
    console.log(`📺 Using existing session: ${sessionName}`);
    
    // Check if Claude is running in this session
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
      // Get only the last 30 lines to check current state, not history
      const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p | tail -30`);
      const output = stdout; // Don't convert to lowercase for box character detection
      
      // Check if Claude is currently active and ready for input
      // Look for the active Claude input prompt box at the END of output
      const lines = output.trim().split('\n');
      const lastFewLines = lines.slice(-10).join('\n');
      
      // Check if the prompt box is currently visible (not in scrollback)
      // Look for the box structure and Claude indicators
      const hasBoxTop = lastFewLines.includes('╭─');
      const hasBoxBottom = lastFewLines.includes('╰─');
      const hasPromptLine = lastFewLines.match(/│\s*>/); // Matches │ followed by any spaces then >
      const hasClaudeIndicators = lastFewLines.includes('Bypassing Permissions') || 
                                   lastFewLines.includes('? for shortcuts') ||
                                   lastFewLines.includes('Context left until');
      
      if (hasBoxTop && hasBoxBottom && hasPromptLine && hasClaudeIndicators) {
        console.log(`✅ Claude is already running in session: ${sessionName}`);
      } else {
        console.log(`🚀 Starting Claude in existing session: ${sessionName}`);
        // Start Claude in the existing session
        await execAsync(`tmux send-keys -t ${sessionName} 'claude --dangerously-skip-permissions --continue'`);
        await execAsync(`tmux send-keys -t ${sessionName} Enter`);
        
        // Wait for Claude to start (5 seconds)
        console.log(`⏳ Waiting 5 seconds for Claude to fully initialize...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log(`✅ Claude started in session: ${sessionName}`);
      }
    } catch (error) {
      console.warn(`⚠️ Could not check/start Claude in session: ${sessionName}`);
    }
    
    return {
      success: true,
      sessionName,
      instanceId: sessionNameToInstanceId(sessionName),
      created: false
    };
  } else {
    console.log(`📺 Session '${sessionName}' not found, creating new one...`);
    const spawnResult = await tmuxUtils.spawnClaudeInstance(process.cwd());
    
    if (spawnResult.success) {
      // Rename the auto-generated session to the custom name
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      try {
        await execAsync(`tmux rename-session -t ${spawnResult.sessionName} ${sessionName}`);
        console.log(`✅ Created and renamed session to: ${sessionName}`);
        
        return {
          success: true,
          sessionName,
          instanceId: sessionNameToInstanceId(sessionName),
          created: true
        };
      } catch (error) {
        console.warn(`⚠️ Failed to rename session, using: ${spawnResult.sessionName}`);
        return {
          success: true,
          sessionName: spawnResult.sessionName,
          instanceId: spawnResult.instanceId,
          created: true
        };
      }
    } else {
      return {
        success: false,
        error: spawnResult.error
      };
    }
  }
}

async function createTempConfig(task, instanceId, sessionName, preset, customStages) {
  // If sessionName is provided, convert it to instanceId
  if (sessionName && !instanceId) {
    instanceId = sessionNameToInstanceId(sessionName);
  }
  // Special handling for phase preset - use the full workflow file
  if (preset === 'phase') {
    const phaseConfigPath = path.join(__dirname, 'phase_implementation_workflow.json');
    const phaseConfig = JSON.parse(await fs.promises.readFile(phaseConfigPath, 'utf8'));
    
    // Update with current task and instance
    phaseConfig.instanceId = instanceId || "YOUR_INSTANCE_ID";
    phaseConfig.taskDescription = task;
    
    // Replace {{TASK}} placeholder in initialPrompt if it exists
    if (phaseConfig.initialPrompt && phaseConfig.initialPrompt.includes('{{TASK}}')) {
      phaseConfig.initialPrompt = replaceTemplatePlaceholders(phaseConfig.initialPrompt, { TASK: task });
    }
    
    const tempFile = path.join(process.cwd(), `.quick_task_${Date.now()}.json`);
    await fs.promises.writeFile(tempFile, JSON.stringify(phaseConfig, null, 2));
    return tempFile;
  }
  
  // Regular handling for other presets
  const stages = customStages 
    ? customStages.map((stage, i) => ({
        keyword: i === 0 ? "STARTED" : customStages[i-1].toUpperCase() + "_DONE",
        nextStage: stage,
        nextKeyword: stage.toUpperCase() + "_DONE"
      }))
    : STAGE_PRESETS[preset] || STAGE_PRESETS.default;
  
  const config = {
    instanceId: instanceId || "YOUR_INSTANCE_ID",
    taskDescription: task,
    chains: buildChains(stages),
    initialPrompt: `Please execute the following task: '{{TASK}}'. Start by implementing a solution. When you have completed the initial implementation, end by saying ${stages[0].keyword}`,
    options: {
      pollInterval: 5,
      timeout: 1800,
      retryAttempts: 3,
      retryDelay: 2
    }
  };
  
  const tempFile = path.join(process.cwd(), `.quick_task_${Date.now()}.json`);
  await fs.promises.writeFile(tempFile, JSON.stringify(config, null, 2));
  
  return tempFile;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
🚀 QUICK TASK RUNNER
===================

Run a task through multiple stages with a single command!

USAGE:
  node quick_task.js "<task description>" [options]

OPTIONS:
  --instance <id>     Specify Claude instance ID (otherwise uses latest)
  --session <name>    Use existing tmux session (e.g. claude_auto_1234567)
  --name <name>       Create/use named session (exact name, e.g. 'dev', 'test')
  --preset <name>     Use a preset workflow: default, debug, or review
  --stages <list>     Custom stages (comma-separated)

EXAMPLES:
  # Simple task with default stages (implement → test → document)
  node quick_task.js "Create a function to validate email addresses"
  
  # Use/create named session (creates 'dev' if doesn't exist)
  node quick_task.js "Fix bug in auth" --name dev
  node quick_task.js "Add feature" -n main
  
  # Use existing tmux session instead of auto-spawning
  node quick_task.js "Fix bug in auth" --session claude_auto_1752513822021
  
  # Debug workflow (reproduce → diagnose → fix → verify)
  node quick_task.js "Fix memory leak in image processor" --preset debug
  
  # Custom stages
  node quick_task.js "Refactor auth module" --stages analyze,plan,refactor,test,deploy
  
  # Specific instance ID
  node quick_task.js "Add user avatars" --instance spec_1_1_123456

AVAILABLE PRESETS:
  default: implement → test → document → finalize
  debug:   reproduce → diagnose → fix → verify  
  review:  analyze → refactor → test → commit
  phase:   execute → compare → deduplicate → cleanup

The task will automatically progress through each stage!
    `);
    process.exit(0);
  }
  
  try {
    const { task, instanceId, sessionName, customName, preset, customStages } = parseArgs(args);
    
    if (!task) {
      console.error('❌ No task specified');
      console.error('Usage: node quick_task.js "Your task description"');
      process.exit(1);
    }
    
    console.log('🚀 QUICK TASK RUNNER');
    console.log('===================\n');
    console.log(`📋 Task: "${task}"`);
    console.log(`🔄 Workflow: ${customStages ? 'custom (' + customStages.join(' → ') + ')' : preset}`);
    if (instanceId) console.log(`🎯 Instance: ${instanceId}`);
    if (sessionName) console.log(`📺 Session: ${sessionName}`);
    if (customName) console.log(`📺 Name: ${customName}`);
    console.log();
    
    // Handle custom named session
    let finalSessionName = sessionName;
    let finalInstanceId = instanceId;
    
    if (customName) {
      const namedResult = await handleNamedSession(customName);
      if (!namedResult.success) {
        console.error(`💥 Failed to handle named session: ${namedResult.error}`);
        process.exit(1);
      }
      finalSessionName = namedResult.sessionName;
      finalInstanceId = namedResult.instanceId;
    }
    
    // Create temporary config
    console.log('📝 Creating task configuration...');
    const configFile = await createTempConfig(task, finalInstanceId, finalSessionName, preset, customStages);
    
    // Run the task chain launcher
    console.log('🔗 Starting task chain...\n');
    const launcherPath = path.join(__dirname, 'task_chain_launcher.js');
    const launcher = spawn('node', [launcherPath, configFile], {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    
    // Cleanup on exit
    launcher.on('exit', (code) => {
      // Clean up temp file
      fs.promises.unlink(configFile).catch(() => {});
      process.exit(code || 0);
    });
    
    // Handle interrupts
    process.on('SIGINT', () => {
      launcher.kill('SIGINT');
      fs.promises.unlink(configFile).catch(() => {});
      process.exit(0);
    });
    
  } catch (error) {
    console.error('💥 Error:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}