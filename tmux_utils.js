/**
 * Direct tmux utilities - Replace MCP bridge with simple tmux commands
 * Provides the same interface as MCP bridge but uses direct tmux operations
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Execute tmux command with proper error handling
 */
async function executeTmuxCommand(command, args = []) {
  try {
    // Properly quote arguments that contain special characters
    const quotedArgs = args.map(arg => {
      // If arg contains special characters, quote it
      if (arg.includes('|') || arg.includes('#') || arg.includes(' ')) {
        return `'${arg}'`;
      }
      return arg;
    });
    
    const fullCommand = `tmux ${command} ${quotedArgs.join(' ')}`;
    const { stdout, stderr } = await execAsync(fullCommand);
    if (stderr && !stderr.includes('Warning')) {
      console.warn('tmux warning:', stderr);
    }
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return { 
      success: false, 
      error: error.message,
      code: error.code 
    };
  }
}

/**
 * Check if a tmux session exists
 */
export async function sessionExists(sessionName) {
  const result = await executeTmuxCommand('has-session', ['-t', sessionName]);
  return result.success;
}

/**
 * List all Claude instances from tmux sessions
 * Returns format compatible with MCP bridge: {success: true, instances: [{instanceId, sessionName, created}]}
 */
export async function listInstances() {
  try {
    const result = await executeTmuxCommand('list-sessions', ['-F', '#{session_name}|#{session_created}']);
    
    if (!result.success) {
      return { success: true, instances: [] }; // No sessions is valid
    }

    const lines = result.output.split('\\n').filter(line => line.length > 0);
    const instances = [];

    for (const line of lines) {
      const cleanLine = line.replace(/"/g, ''); // Remove quotes
      const [sessionName, created] = cleanLine.split('|');
      
      // Only include Claude sessions
      if (sessionName && sessionName.startsWith('claude_')) {
        const instanceId = sessionName.replace('claude_', '');
        instances.push({
          instanceId,
          sessionName,
          created: new Date(parseInt(created) * 1000).toISOString(),
          status: 'active'
        });
      }
    }

    return { success: true, instances };
  } catch (error) {
    return { 
      success: false, 
      error: `Failed to list instances: ${error.message}`,
      instances: [] 
    };
  }
}

/**
 * Sanitize text for tmux send-keys command
 * Prevents shell injection and handles special characters
 */
function sanitizeText(text) {
  if (typeof text !== 'string') {
    text = String(text);
  }
  
  // Escape single quotes by ending quote, adding escaped quote, starting quote again
  return text.replace(/'/g, "'\"'\"'");
}

/**
 * Send text to a Claude instance via tmux send-keys
 * Returns format compatible with MCP bridge: {success: true/false, error?: string}
 */
export async function sendToInstance(instanceId, text) {
  // Handle different instance ID formats:
  // - auto_1234567 -> claude_auto_1234567
  // - test -> test (custom named session)
  // - spec_1_1_123 -> claude_spec_1_1_123
  let sessionName;
  
  // If instanceId already looks like a session name (no underscores or doesn't start with common prefixes)
  if (!instanceId.includes('_') || (!instanceId.startsWith('auto_') && !instanceId.startsWith('spec_'))) {
    // Assume it's a direct session name
    sessionName = instanceId;
  } else {
    // Traditional format - add claude_ prefix
    sessionName = `claude_${instanceId}`;
  }
  
  // Validate session exists first
  if (!(await sessionExists(sessionName))) {
    return { 
      success: false, 
      error: `Session ${sessionName} does not exist` 
    };
  }

  // Sanitize text to prevent shell injection
  const sanitizedText = sanitizeText(text);
  
  try {
    // Send the text using direct exec to handle quoting properly
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Send the text first
    await execAsync(`tmux send-keys -t '${sessionName}' '${sanitizedText}'`);
    // Then send Enter as a separate command
    await execAsync(`tmux send-keys -t '${sessionName}' Enter`);
    
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: `Send failed: ${error.message}` 
    };
  }
}

/**
 * Read output from Claude instance via tmux capture-pane
 * Returns format compatible with MCP bridge: {success: true, output: string}
 */
export async function readFromInstance(instanceId, lines = 50) {
  // Handle different instance ID formats (same logic as sendToInstance)
  let sessionName;
  
  // If instanceId already looks like a session name (no underscores or doesn't start with common prefixes)
  if (!instanceId.includes('_') || (!instanceId.startsWith('auto_') && !instanceId.startsWith('spec_'))) {
    // Assume it's a direct session name
    sessionName = instanceId;
  } else {
    // Traditional format - add claude_ prefix
    sessionName = `claude_${instanceId}`;
  }
  
  // Validate session exists first
  if (!(await sessionExists(sessionName))) {
    return { 
      success: false, 
      error: `Session ${sessionName} does not exist`,
      output: ''
    };
  }

  try {
    // Capture pane content
    const result = await executeTmuxCommand('capture-pane', [
      '-t', sessionName,
      '-p'  // print to stdout
    ]);
    
    if (!result.success) {
      return { 
        success: false, 
        error: `Failed to read from ${sessionName}: ${result.error}`,
        output: ''
      };
    }
    
    let output = result.output;
    
    // If lines specified, get only the last N lines
    if (lines > 0) {
      const outputLines = output.split('\\n');
      if (outputLines.length > lines) {
        output = outputLines.slice(-lines).join('\\n');
      }
    }
    
    return { success: true, output };
  } catch (error) {
    return { 
      success: false, 
      error: `Read failed: ${error.message}`,
      output: ''
    };
  }
}

/**
 * Spawn a new Claude instance in tmux session
 * Uses: cd directory && claude --dangerously-skip-permissions --continue
 */
export async function spawnClaudeInstance(workingDir = process.cwd()) {
  // Generate unique instance ID
  const instanceId = `auto_${Date.now()}`;
  const sessionName = `claude_${instanceId}`;
  
  try {
    console.log(`🚀 Spawning Claude instance: ${instanceId}`);
    console.log(`📁 Working directory: ${workingDir}`);
    
    // Create new tmux session with bash shell
    const sessionResult = await executeTmuxCommand('new-session', [
      '-d',
      '-s', sessionName,
      '-c', workingDir,
      'bash'
    ]);
    
    if (!sessionResult.success) {
      return {
        success: false,
        error: `Failed to create tmux session: ${sessionResult.error}`,
        instanceId: null
      };
    }
    
    // Wait a moment for session to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Send claude command to the session  
    const claudeResult = await executeTmuxCommand('send-keys', [
      '-t', sessionName,
      'claude --dangerously-skip-permissions',
      'Enter'
    ]);
    
    if (!claudeResult.success) {
      // Clean up the session
      await executeTmuxCommand('kill-session', ['-t', sessionName]);
      return {
        success: false,
        error: `Failed to start Claude: ${claudeResult.error}`,
        instanceId: null
      };
    }
    
    // Wait for Claude to start up and verify it's ready
    console.log('⏳ Waiting for Claude to initialize...');
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
      
      // Check if Claude is ready by reading the session output
      const testResult = await executeTmuxCommand('capture-pane', ['-t', sessionName, '-p']);
      
      if (testResult.success) {
        const output = testResult.output.toLowerCase();
        // Check if Claude needs an update
        if (output.includes('needs an update') || output.includes('claude update')) {
          return {
            success: false,
            error: 'Claude Code needs an update. Please run: claude update',
            instanceId: null
          };
        }
        
        // Check if Claude started but dropped to bash
        if (output.includes('welcome to claude code') && output.includes('bash-')) {
          console.log(`🔄 Claude started but dropped to bash, restarting...`);
          
          // Restart Claude in the session
          await executeTmuxCommand('send-keys', ['-t', sessionName, 'claude --dangerously-skip-permissions', 'Enter']);
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const restartResult = await executeTmuxCommand('capture-pane', ['-t', sessionName, '-p']);
          if (restartResult.success) {
            const restartOutput = restartResult.output.toLowerCase();
            if (restartOutput.includes('welcome to claude code') && !restartOutput.includes('bash-')) {
              console.log(`✅ Claude instance restarted and ready: ${instanceId}`);
              return {
                success: true,
                instanceId,
                sessionName
              };
            }
          }
        } 
        // Check if Claude is ready for input - look for the input prompt box
        else if (output.includes('│ >') && output.includes('╭─') && output.includes('╰─')) {
          console.log(`✅ Claude instance spawned and ready: ${instanceId}`);
          return {
            success: true,
            instanceId,
            sessionName
          };
        }
      }
      
      console.log(`⏳ Attempt ${attempts}/${maxAttempts}: Claude still initializing...`);
    }
    
    // If we get here, Claude didn't start properly but session exists
    if (await sessionExists(sessionName)) {
      console.log(`⚠️ Session exists but Claude may not be fully ready: ${instanceId}`);
      return {
        success: true,
        instanceId,
        sessionName
      };
    } else {
      return {
        success: false,
        error: `Session ${sessionName} failed to start properly`,
        instanceId: null
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: `Failed to spawn Claude instance: ${error.message}`,
      instanceId: null
    };
  }
}

/**
 * Get the latest (most recently created) instance ID
 * Auto-spawns an instance if none exist
 */
export async function getLatestInstanceId() {
  const result = await listInstances();
  
  // If we have existing instances, return the latest
  if (result.success && result.instances.length > 0) {
    const sorted = result.instances.sort((a, b) => new Date(b.created) - new Date(a.created));
    return sorted[0].instanceId;
  }
  
  // No instances found - spawn a new one
  console.log('🔍 No active Claude instances found');
  console.log('🚀 Auto-spawning new Claude instance...');
  
  const spawnResult = await spawnClaudeInstance();
  
  if (!spawnResult.success) {
    throw new Error(`Failed to spawn Claude instance: ${spawnResult.error}`);
  }
  
  return spawnResult.instanceId;
}

export default {
  sessionExists,
  listInstances,
  sendToInstance,
  readFromInstance,
  getLatestInstanceId,
  spawnClaudeInstance
};