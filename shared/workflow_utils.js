/**
 * Shared utilities for workflow system
 * Consolidates common functionality to eliminate duplication
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Check if keyword appears as actual completion signal vs just mentioned in content
 * Consolidated from chain_keyword_monitor.js and debug_keyword_monitor.js
 */
export function isActualCompletionSignal(line, keyword) {
  const trimmedLine = line.trim();
  
  // Ignore if keyword appears in planning, thinking, or instructional content
  const ignoredPatterns = [
    '☐', '□', '⎿', 'Document', 'signal completion', 'with ' + keyword,
    'and ' + keyword, 'using ' + keyword, 'say ' + keyword, 'Say ' + keyword,
    'type ' + keyword, 'Execute step', 'Step ', 'execute it', 'plan:',
    'todo list', 'Create', 'Analyze', 'then execute', ': Say', '. Say',
    'Let me', 'I need to', 'I will', 'I should'
  ];
  
  for (const pattern of ignoredPatterns) {
    if (trimmedLine.includes(pattern)) {
      return false;
    }
  }
  
  // Ignore numbered list items
  if (trimmedLine.match(/^\d+\./)) {
    return false;
  }
  
  // For keywords ending with ':', accept pattern with any suffix
  if (keyword.endsWith(':')) {
    const keywordPattern = new RegExp('^' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\S*$');
    return (
      keywordPattern.test(trimmedLine) ||  // Keyword with suffix
      keywordPattern.test(trimmedLine.replace(/^⏺\s*/, ''))  // With Claude marker
    );
  }
  
  // Only accept if keyword appears as true standalone completion signal
  return (
    trimmedLine === keyword ||  // Exactly the keyword alone
    trimmedLine === `⏺ ${keyword}` ||  // With Claude marker only
    (trimmedLine.startsWith('⏺') && trimmedLine.endsWith(keyword) && trimmedLine.length < keyword.length + 10)
  );
}

/**
 * Load and parse JSON configuration file
 * Consolidated from multiple config loading implementations
 */
export async function loadConfig(configPath, requiredFields = []) {
  try {
    const configData = await fs.promises.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Validate required fields if specified
    for (const field of requiredFields) {
      if (!config[field]) {
        throw new Error(`Config must include ${field} field`);
      }
    }
    
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    } else if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Replace template placeholders in text
 * Consolidated from multiple template replacement implementations
 */
export function replaceTemplatePlaceholders(text, replacements) {
  let result = text;
  for (const [placeholder, value] of Object.entries(replacements)) {
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    result = result.replace(regex, value);
  }
  return result;
}



/**
 * Parse command line arguments in a standard way
 * Returns an object with parsed options
 */
export function parseCommandLineArgs(args, options = {}) {
  const result = {
    positional: [],
    flags: {}
  };
  
  const {
    booleanFlags = [],
    stringFlags = [],
    aliases = {}
  } = options;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--') || arg.startsWith('-')) {
      const flagName = arg.replace(/^-+/, '');
      const actualFlag = aliases[flagName] || flagName;
      
      if (booleanFlags.includes(actualFlag)) {
        result.flags[actualFlag] = true;
      } else if (stringFlags.includes(actualFlag) && args[i + 1] && !args[i + 1].startsWith('-')) {
        result.flags[actualFlag] = args[i + 1];
        i++; // Skip next arg
      } else {
        result.flags[flagName] = true; // Unknown flag, treat as boolean
      }
    } else {
      result.positional.push(arg);
    }
  }
  
  return result;
}

/**
 * Normalize instance ID to session name format
 * Handles different instance ID formats consistently
 */
export function normalizeInstanceId(instanceId) {
  // Handle different instance ID formats:
  // - auto_1234567 -> claude_auto_1234567 (traditional)
  // - test -> test (custom named session)
  // - spec_1_1_123 -> claude_spec_1_1_123 (traditional)
  
  if (!instanceId.includes('_') || (!instanceId.startsWith('auto_') && !instanceId.startsWith('spec_'))) {
    return instanceId; // Direct session name
  }
  return `claude_${instanceId}`; // Traditional format
}

/**
 * Convert instance ID to session name format
 * Alias for normalizeInstanceId for clarity
 */
export function instanceIdToSessionName(instanceId) {
  return normalizeInstanceId(instanceId);
}

/**
 * Convert session name back to instance ID format
 * Reverses the instanceIdToSessionName conversion
 */
export function sessionNameToInstanceId(sessionName) {
  if (sessionName.startsWith('claude_')) {
    return sessionName.replace('claude_', '');
  }
  return sessionName;
}

/**
 * Base monitor event handlers
 * Common event setup for keyword monitors
 */
export function setupMonitorEventHandlers(monitor, options = {}) {
  const {
    onStarted = () => console.log('🎯 Monitor started successfully'),
    onStopped = () => console.log('🛑 Monitor stopped'),
    onError = (error) => console.error('💥 Monitor error:', error),
    onTimeout = () => console.log('⏰ Monitor timeout reached')
  } = options;
  
  monitor.on('started', onStarted);
  monitor.on('stopped', onStopped);
  monitor.on('error', onError);
  monitor.on('timeout', onTimeout);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down monitor...');
    monitor.stop();
    setTimeout(() => process.exit(0), 1000);
  });
}

/**
 * List all available workflow presets from the workflows directory
 * Returns array of workflow names without .json extension
 */
export async function listAvailableWorkflows() {
  try {
    const workflowsDir = join(dirname(dirname(__filename)), 'workflows');
    const files = await fs.promises.readdir(workflowsDir);
    
    // Filter for .json files and remove extension
    const workflows = files
      .filter(file => file.endsWith('.json') && !file.startsWith('.'))
      .map(file => file.replace('.json', ''))
      .sort();
    
    return workflows;
  } catch (error) {
    // If workflows directory doesn't exist, return empty array
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Validate a workflow configuration structure
 * Returns {valid: boolean, errors: string[]}
 */
export function validateWorkflow(workflow) {
  const errors = [];
  
  // Check required top-level fields
  const requiredFields = ['name', 'description', 'chains', 'initialPrompt', 'options'];
  for (const field of requiredFields) {
    if (!workflow[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Validate chains structure
  if (Array.isArray(workflow.chains)) {
    if (workflow.chains.length === 0) {
      errors.push('Chains array cannot be empty');
    }
    
    workflow.chains.forEach((chain, index) => {
      if (!chain.keyword) {
        errors.push(`Chain ${index} missing required field: keyword`);
      }
      if (!chain.instruction) {
        errors.push(`Chain ${index} missing required field: instruction`);
      }
      // nextKeyword is optional on the last chain
      if (index < workflow.chains.length - 1 && !chain.nextKeyword) {
        errors.push(`Chain ${index} missing nextKeyword (required except on last chain)`);
      }
    });
  } else if (workflow.chains) {
    errors.push('Chains must be an array');
  }
  
  // Validate options structure
  if (workflow.options && typeof workflow.options !== 'object') {
    errors.push('Options must be an object');
  }
  
  // Check for {{TASK}} placeholder in prompts
  if (workflow.initialPrompt && !workflow.initialPrompt.includes('{{TASK}}')) {
    errors.push('initialPrompt should include {{TASK}} placeholder');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Build a workflow configuration from a preset
 * Loads the workflow and replaces {{TASK}} placeholders
 */
export async function buildWorkflowFromPreset(presetName, task, instanceId = null) {
  // Load the workflow preset
  const workflow = await loadWorkflow(presetName);
  
  // Build the config in the format expected by task_chain_launcher
  const config = {
    instanceId: instanceId || "YOUR_INSTANCE_ID",
    taskDescription: task,
    chains: workflow.chains.map(chain => ({
      keyword: chain.keyword,
      instruction: replaceTemplatePlaceholders(chain.instruction, { TASK: task }),
      ...(chain.nextKeyword && { nextKeyword: chain.nextKeyword })
    })),
    initialPrompt: replaceTemplatePlaceholders(workflow.initialPrompt, { TASK: task }),
    options: workflow.options || {
      pollInterval: 5,
      timeout: 600,
      retryAttempts: 3,
      retryDelay: 2
    }
  };
  
  return config;
}

/**
 * Load a workflow by name from the workflows directory
 * Validates the workflow structure before returning
 */
export async function loadWorkflow(name) {
  const workflowsDir = join(dirname(dirname(__filename)), 'workflows');
  const workflowPath = join(workflowsDir, `${name}.json`);
  
  try {
    const workflowData = await fs.promises.readFile(workflowPath, 'utf8');
    const workflow = JSON.parse(workflowData);
    
    // Validate the loaded workflow
    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      throw new Error(`Invalid workflow '${name}': ${validation.errors.join(', ')}`);
    }
    
    return workflow;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Check available workflows for helpful error message
      const available = await listAvailableWorkflows();
      throw new Error(
        `Workflow '${name}' not found. Available workflows: ${available.join(', ') || 'none'}`
      );
    }
    throw error;
  }
}

export default {
  isActualCompletionSignal,
  loadConfig,
  replaceTemplatePlaceholders,
  parseCommandLineArgs,
  setupMonitorEventHandlers,
  normalizeInstanceId,
  instanceIdToSessionName,
  sessionNameToInstanceId,
  listAvailableWorkflows,
  loadWorkflow,
  validateWorkflow,
  buildWorkflowFromPreset
};