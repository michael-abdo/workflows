#!/usr/bin/env node
/**
 * Chain Keyword Monitor - Advanced workflow chaining with keyword triggers
 * 
 * Extends DebugKeywordMonitor to automatically send follow-up instructions
 * when keywords are detected, enabling seamless workflow chaining.
 * 
 * Usage: node chain_keyword_monitor.js <configFile>
 * 
 * Config format:
 * {
 *   "instanceId": "spec_1_1_123456",
 *   "chains": [
 *     {
 *       "keyword": "***STAGE1_COMPLETE***",
 *       "instruction": "Now execute stage 2: Create the implementation plan",
 *       "nextKeyword": "***STAGE2_COMPLETE***"
 *     },
 *     {
 *       "keyword": "***STAGE2_COMPLETE***", 
 *       "instruction": "Execute stage 3: Begin implementation",
 *       "nextKeyword": "***STAGE3_COMPLETE***"
 *     }
 *   ],
 *   "options": {
 *     "pollInterval": 5,
 *     "timeout": 600,
 *     "retryAttempts": 3,
 *     "retryDelay": 2
 *   }
 * }
 */

import { EventEmitter } from 'events';
import { isActualCompletionSignal, loadConfig } from './shared/workflow_utils.js';
import { sendToInstance, readFromInstance } from './tmux_utils.js';

class ChainKeywordMonitor extends EventEmitter {
  constructor(config) {
    super();
    
    // Validate config
    if (!config.instanceId) {
      throw new Error('Missing required config: instanceId');
    }
    if (!config.chains || !Array.isArray(config.chains)) {
      throw new Error('Missing required config: chains array');
    }
    
    this.instanceId = config.instanceId;
    this.chains = config.chains;
    this.options = config.options || {};
    
    // Monitor configuration
    this.pollInterval = (this.options.pollInterval || 5) * 1000;
    this.timeout = (this.options.timeout || 600) * 1000;
    this.retryAttempts = this.options.retryAttempts || 3;
    this.retryDelay = (this.options.retryDelay || 2) * 1000;
    
    // State management
    this.currentChainIndex = 0;
    this.currentKeyword = this.chains[0]?.keyword;
    this.isActive = false;
    this.startTime = null;
    this.interval = null;
    this.lastReadPosition = 0;
    this.outputBuffer = '';
    this.pollCount = 0;
    this.executedChains = [];
    
    // Watch mechanism to prevent duplicate detections
    this.detectedKeywords = new Set();
    this.lastDetectedPosition = new Map();
    
    // Direct tmux operations - no bridge abstraction needed
    
    // Build keyword map for quick lookup
    this.keywordMap = new Map();
    this.chains.forEach((chain, index) => {
      this.keywordMap.set(chain.keyword, { ...chain, chainIndex: index });
    });
    
    console.log('🔗 CHAIN KEYWORD MONITOR INITIALIZED');
    console.log(`📋 Instance ID: ${this.instanceId}`);
    console.log(`🔗 Chain Length: ${this.chains.length} stages`);
    console.log(`🔍 Starting Keyword: "${this.currentKeyword}"`);
  }

  start() {
    if (this.isActive) {
      console.log('⚠️  Monitor already running');
      return;
    }
    
    this.isActive = true;
    this.startTime = Date.now();
    
    console.log('\n🚀 STARTING CHAIN KEYWORD MONITOR');
    console.log(`⏱️  Poll Interval: ${this.pollInterval/1000}s`);
    console.log(`⏰ Total Timeout: ${this.timeout/1000}s`);
    console.log(`🔄 Retry Attempts: ${this.retryAttempts}`);
    console.log('━'.repeat(80));
    
    // Start polling
    this.interval = setInterval(() => {
      this.checkOutput().catch(error => {
        console.error('💥 ERROR in checkOutput:', error);
        this.emit('error', error);
      });
    }, this.pollInterval);
    
    // Do an immediate check
    this.checkOutput().catch(console.error);
    
    this.emit('started');
  }

  stop() {
    if (!this.isActive) {
      return;
    }
    
    console.log('\n🛑 STOPPING CHAIN KEYWORD MONITOR');
    this.isActive = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.emit('stopped');
  }

  async checkOutput() {
    if (!this.isActive) return;
    
    this.pollCount++;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    
    console.log(`\n📊 POLL #${this.pollCount} (${elapsed}s) - Looking for: "${this.currentKeyword}"`);
    
    try {
      // Check for timeout
      if (Date.now() - this.startTime > this.timeout) {
        console.log('⏰ TIMEOUT REACHED');
        this.stop();
        this.emit('timeout', { 
          currentChain: this.currentChainIndex,
          executedChains: this.executedChains.length 
        });
        return;
      }

      // Read output from instance
      const result = await readFromInstance(this.instanceId, 200);

      if (!result.success) {
        console.error('❌ Failed to read instance output:', result.error);
        throw new Error(result.error || 'Failed to read instance output');
      }

      let newOutput = result.output || '';
      
      // Handle case where output is wrapped in JSON from MCP bridge
      if (newOutput.includes('{"success":true,"output":"')) {
        try {
          const match = newOutput.match(/{"success":true,"output":"(.*)"}$/);
          if (match) {
            // Extract actual output and convert escaped newlines to real newlines
            newOutput = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
          }
        } catch (e) {
          // If parsing fails, use raw output
        }
      }
      
      if (newOutput.length > 0) {
        console.log(`📝 New output: ${newOutput.length} characters`);
      } else {
        console.log('📝 No new output detected');
      }
      
      // Update buffer - increased size to handle larger outputs
      this.outputBuffer = this.outputBuffer.slice(-10000) + newOutput;
      
      // Check for current keyword
      await this.checkForKeywords();
      
    } catch (error) {
      console.error('💥 Error in checkOutput:', error);
      throw error;
    }
  }

  async checkForKeywords() {
    // Check if any keyword in our chain is present
    for (const [keyword, chainConfig] of this.keywordMap) {
      if (await this.detectKeywordInOutput(keyword)) {
        console.log(`🎯 KEYWORD DETECTED: "${keyword}"`);
        await this.executeChainAction(chainConfig);
        return;
      }
    }
  }

  async detectKeywordInOutput(keyword) {
    if (!this.outputBuffer.includes(keyword)) {
      return false;
    }
    
    // Check if we've already detected this keyword at this position
    const currentPosition = this.outputBuffer.lastIndexOf(keyword);
    const lastPosition = this.lastDetectedPosition.get(keyword) || -1;
    
    if (currentPosition <= lastPosition) {
      // Already processed this occurrence
      return false;
    }
    
    console.log(`🔍 Checking keyword: "${keyword}"`);
    
    // Split buffer into lines for context analysis
    const lines = this.outputBuffer.split('\n');
    let inUserCommand = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // Track user command state (inherited from debug monitor)
      if (trimmedLine.startsWith('>')) {
        inUserCommand = true;
        console.log(`🟡 User command started at line ${i}`);
      }
      
      if (inUserCommand && trimmedLine.includes('⏺')) {
        inUserCommand = false;
        console.log(`🟢 User command ended at line ${i}`);
      }
      
      // Check for keyword with flexible matching for colon patterns
      const hasKeyword = keyword.endsWith(':') ? 
        new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\S*').test(line) :
        line.includes(keyword);
        
      if (hasKeyword) {
        // Check if this is user input
        const isUserInput = inUserCommand || 
                           trimmedLine.startsWith('>') || 
                           line.includes('plz say') || 
                           line.includes('please say') ||
                           line.includes('type:') ||
                           (line.includes('Todo:') && line.includes(keyword)) ||
                           (line.includes('Task:') && line.includes(keyword)) ||
                           (line.includes('Given the following') && line.includes(keyword));
        
        if (isUserInput) {
          console.log(`🚫 Ignoring keyword in user input: "${trimmedLine.substring(0, 100)}..."`);
          continue;
        }
        
        // Check if this is a completion signal vs just mentioning the keyword
        const isCompletion = isActualCompletionSignal(line, keyword);
        
        if (!isCompletion) {
          console.log(`🔸 Keyword found but not as completion signal: "${trimmedLine.substring(0, 100)}..."`);
          continue;
        }
        
        console.log('🎉 VALID COMPLETION KEYWORD DETECTED!');
        console.log(`✅ Found: "${keyword}" in line: "${trimmedLine}"`);
        
        // Show context
        const keywordIndex = this.outputBuffer.lastIndexOf(keyword);
        const contextStart = Math.max(0, keywordIndex - 150);
        const contextEnd = Math.min(this.outputBuffer.length, keywordIndex + keyword.length + 150);
        const context = this.outputBuffer.slice(contextStart, contextEnd);
        
        console.log('📍 Context:');
        console.log('─'.repeat(60));
        console.log(context);
        console.log('─'.repeat(60));
        
        // Mark this position as detected
        this.lastDetectedPosition.set(keyword, keywordIndex);
        this.detectedKeywords.add(keyword);
        
        return true;
      }
    }
    
    return false;
  }


  async executeChainAction(chainConfig) {
    const { keyword, instruction, nextKeyword, chainIndex } = chainConfig;
    
    // Prevent duplicate execution
    const executionKey = `${keyword}-${chainIndex}`;
    if (this.executedChains.some(chain => chain.keyword === keyword && chain.chainIndex === chainIndex)) {
      console.log(`⚠️  Chain action for "${keyword}" already executed, skipping`);
      return;
    }
    
    console.log('\n🎬 EXECUTING CHAIN ACTION');
    console.log(`🔗 Chain ${chainIndex + 1}/${this.chains.length}`);
    console.log(`📝 Instruction: "${instruction}"`);
    
    // Record this execution
    this.executedChains.push({
      keyword,
      instruction,
      timestamp: new Date().toISOString(),
      chainIndex
    });
    
    this.emit('chain_executed', { keyword, instruction, chainIndex });
    
    // Send the instruction with retry logic
    const success = await this.sendInstructionWithRetry(instruction);
    
    if (!success) {
      console.error('❌ Failed to send instruction after all retries');
      this.emit('chain_failed', { keyword, instruction, chainIndex });
      this.stop();
      return;
    }
    
    // Update state for next keyword
    if (nextKeyword) {
      this.currentKeyword = nextKeyword;
      this.currentChainIndex = chainIndex + 1;
      console.log(`🔄 Next keyword: "${nextKeyword}"`);
    } else {
      // Chain complete
      console.log('\n🏁 CHAIN COMPLETE - All stages executed successfully');
      this.emit('chain_complete', {
        totalStages: this.executedChains.length,
        executedChains: this.executedChains
      });
      this.stop();
    }
  }

  async sendInstructionWithRetry(instruction) {
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        console.log(`📤 Sending instruction (attempt ${attempt}/${this.retryAttempts})`);
        
        const result = await sendToInstance(this.instanceId, instruction);
        
        if (result.success) {
          console.log('✅ Instruction sent successfully');
          return true;
        } else {
          console.error(`❌ Send failed: ${result.error}`);
        }
        
      } catch (error) {
        console.error(`💥 Send error (attempt ${attempt}): ${error.message}`);
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < this.retryAttempts) {
        console.log(`⏳ Waiting ${this.retryDelay/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      }
    }
    
    return false;
  }

  getStatus() {
    return {
      isActive: this.isActive,
      instanceId: this.instanceId,
      currentKeyword: this.currentKeyword,
      currentChainIndex: this.currentChainIndex,
      totalChains: this.chains.length,
      executedChains: this.executedChains.length,
      pollCount: this.pollCount,
      uptime: this.startTime ? Date.now() - this.startTime : 0
    };
  }
}


async function main() {
  const configPath = process.argv[2];
  
  if (!configPath) {
    console.error('Usage: node chain_keyword_monitor.js <configFile>');
    console.error('\nExample config.json:');
    console.error(JSON.stringify({
      instanceId: "spec_1_1_123456",
      chains: [
        {
          keyword: "STAGE1_COMPLETE",
          instruction: "Now execute stage 2: Create the implementation plan",
          nextKeyword: "STAGE2_COMPLETE"
        },
        {
          keyword: "STAGE2_COMPLETE", 
          instruction: "Execute stage 3: Begin implementation"
        }
      ],
      options: {
        pollInterval: 5,
        timeout: 600,
        retryAttempts: 3,
        retryDelay: 2
      }
    }, null, 2));
    process.exit(1);
  }
  
  try {
    console.log(`📖 Loading config from: ${configPath}`);
    const config = await loadConfig(configPath);
    
    const monitor = new ChainKeywordMonitor(config);
    
    // Event handlers
    monitor.on('started', () => {
      console.log('🎯 Chain monitor started successfully');
    });
    
    monitor.on('chain_executed', ({ keyword, instruction, chainIndex }) => {
      console.log(`\n🎊 CHAIN ${chainIndex + 1} EXECUTED`);
      console.log(`🔑 Trigger: ${keyword}`);
      console.log(`📝 Action: ${instruction}`);
    });
    
    monitor.on('chain_complete', ({ totalStages, executedChains }) => {
      console.log('\n🏆 SUCCESS! All chains executed successfully');
      console.log(`📊 Total stages: ${totalStages}`);
      console.log('📋 Execution summary:');
      executedChains.forEach((chain, i) => {
        console.log(`  ${i + 1}. ${chain.keyword} → "${chain.instruction}"`);
      });
    });
    
    monitor.on('chain_failed', ({ keyword, instruction, chainIndex }) => {
      console.error(`\n💥 CHAIN ${chainIndex + 1} FAILED`);
      console.error(`🔑 Trigger: ${keyword}`);
      console.error(`📝 Failed action: ${instruction}`);
    });
    
    monitor.on('timeout', ({ currentChain, executedChains }) => {
      console.log(`\n⏰ TIMEOUT: Monitor timed out at chain ${currentChain + 1}`);
      console.log(`📊 Executed ${executedChains} out of ${config.chains.length} chains`);
    });
    
    monitor.on('error', (error) => {
      console.error('\n💥 MONITOR ERROR:', error);
      process.exit(1);
    });
    
    // Start monitoring
    monitor.start();
    
    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down chain monitor...');
      monitor.stop();
      setTimeout(() => process.exit(0), 1000);
    });
    
  } catch (error) {
    console.error('💥 Failed to start chain monitor:', error.message);
    process.exit(1);
  }
}

// Export for programmatic use
export { ChainKeywordMonitor, loadConfig };

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 Chain monitor crashed:', error);
    process.exit(1);
  });
}