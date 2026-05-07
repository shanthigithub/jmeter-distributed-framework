/**
 * Test Runner Framework
 * Common test execution framework for parallel browser/API tests
 * 
 * This module provides reusable utilities for running performance tests with:
 * - Parallel user execution (like JMeter Thread Groups)
 * - Sequential iterations per user
 * - Transaction timing (like JMeter Transaction Controllers)
 * - Automatic statistics collection
 * - Formatted console reporting
 * 
 * @example
 * const { runParallelTest, timedAction } = require('../lib/test-runner');
 * 
 * async function myTest(userId, iteration) {
 *   const result = await timedAction(userId, 'Login', async () => {
 *     // Your test logic here
 *     return { token: 'abc123' };
 *   });
 *   
 *   return { 
 *     success: true, 
 *     userId, 
 *     iteration,
 *     actionTimings: [result]
 *   };
 * }
 * 
 * const config = {
 *   parallelUsers: 10,
 *   iterations: 3,
 *   thinkTime: 2000
 * };
 * 
 * const results = await runParallelTest(myTest, config);
 * process.exit(results.totalFailures > 0 ? 1 : 0);
 */

/**
 * TransactionTimer - Measures elapsed time for individual actions
 * Similar to JMeter's Transaction Controller
 */
class TransactionTimer {
  constructor(userId, actionName) {
    this.userId = userId;
    this.actionName = actionName;
    this.startTime = Date.now();
  }
  
  /**
   * End the timer and return timing data
   * @param {string} status - 'success' or 'failed'
   * @returns {Object} Timing data with action name, elapsed time, status, timestamp
   */
  end(status = 'success') {
    const elapsed = Date.now() - this.startTime;
    const statusIcon = status === 'success' ? '✅' : '❌';
    console.log(`   ${statusIcon} [${elapsed}ms] ${this.actionName}`);
    
    return {
      action: this.actionName,
      userId: this.userId,
      elapsed: elapsed,
      status: status,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Execute an action with automatic timing and error handling
 * Stores transaction data globally for JTL generation
 * Automatically deducts self-healing overhead from transaction time for accurate performance metrics
 * @param {number} userId - User identifier
 * @param {string} actionName - Name of the action being timed
 * @param {Function} actionFn - Async function to execute
 * @returns {Object} Timing data plus result from actionFn
 */
async function timedAction(userId, actionName, actionFn) {
  const timer = new TransactionTimer(userId, actionName);
  
  // Initialize global transaction storage if it doesn't exist
  if (!global.jmeterTransactions) {
    global.jmeterTransactions = {};
  }
  if (!global.jmeterTransactions[userId]) {
    global.jmeterTransactions[userId] = [];
  }
  
  // Track healing time to exclude from performance metrics
  const healer = global.smartHealer; // Set by test script
  const healingTimeBefore = healer ? healer.getTotalHealingTime() : 0;
  
  try {
    const startTime = Date.now();
    const result = await actionFn();
    const endTime = Date.now();
    
    // Calculate actual transaction time (excluding healing overhead)
    const grossDuration = endTime - startTime;
    const healingTimeAfter = healer ? healer.getTotalHealingTime() : 0;
    const healingOverhead = healingTimeAfter - healingTimeBefore;
    const netDuration = grossDuration - healingOverhead;
    
    const timing = timer.end('success');
    
    // Store transaction data for JTL generation (using net duration without healing)
    global.jmeterTransactions[userId].push({
      name: actionName,
      duration: netDuration / 1000, // Store as seconds, healing time excluded
      timestamp: startTime,
      success: true
    });
    
    return { ...timing, result };
  } catch (error) {
    const endTime = Date.now();
    
    // Calculate net duration even for failures
    const grossDuration = endTime - timer.startTime;
    const healingTimeAfter = healer ? healer.getTotalHealingTime() : 0;
    const healingOverhead = healingTimeAfter - healingTimeBefore;
    const netDuration = grossDuration - healingOverhead;
    
    timer.end('failed');
    
    // Store failed transaction data (using net duration)
    global.jmeterTransactions[userId].push({
      name: actionName,
      duration: netDuration / 1000, // Store as seconds, healing time excluded
      timestamp: timer.startTime,
      success: false,
      error: error.message
    });
    
    throw error;
  }
}

/**
 * Run a single user through all iterations
 * @param {number} userId - User identifier
 * @param {Function} testFunction - Test function to execute (async function(userId, iteration))
 * @param {Object} config - Configuration with iterations and thinkTime
 * @returns {Object} Results for this user including all iterations
 */
async function runUserWorkload(userId, testFunction, config) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`👤 USER ${userId} STARTING`);
  console.log(`${'='.repeat(60)}`);
  
  const userResults = [];
  
  for (let iteration = 1; iteration <= config.iterations; iteration++) {
    console.log(`\n👤 User ${userId}: Starting iteration ${iteration}/${config.iterations}`);
    const result = await testFunction(userId, iteration);
    userResults.push(result);
    
    // Think time between iterations (except after last one)
    if (iteration < config.iterations) {
      console.log(`👤 User ${userId}: Waiting ${config.thinkTime}ms before next iteration...`);
      await new Promise(resolve => setTimeout(resolve, config.thinkTime));
    }
  }
  
  const successCount = userResults.filter(r => r.success).length;
  const failureCount = userResults.filter(r => !r.success).length;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`👤 USER ${userId} COMPLETED`);
  console.log(`   Iterations: ${config.iterations}`);
  console.log(`   Successful: ${successCount} ✅`);
  console.log(`   Failed: ${failureCount} ❌`);
  console.log(`${'='.repeat(60)}\n`);
  
  return {
    userId,
    results: userResults,
    successCount,
    failureCount
  };
}

/**
 * Run parallel users with automatic statistics collection
 * @param {Function} testFunction - Test function to execute for each user/iteration
 * @param {Object} config - Configuration object with parallelUsers, iterations, thinkTime, rampUpTime (optional)
 * @returns {Object} Complete test results with statistics
 */
async function runParallelTest(testFunction, config) {
  const testStart = Date.now();
  
  console.log('🚀 Starting Parallel Test');
  console.log(`📊 Configuration:`);
  console.log(`   - Parallel Users: ${config.parallelUsers}`);
  console.log(`   - Iterations per User: ${config.iterations}`);
  console.log(`   - Think Time: ${config.thinkTime}ms`);
  console.log(`   - Total Executions: ${config.parallelUsers * config.iterations}`);
  
  // Ramp-up time support (like JMeter's ramp-up period)
  const rampUpTime = config.rampUpTime || 0; // seconds
  let delayBetweenUsers = 0;
  
  if (rampUpTime > 0 && config.parallelUsers > 1) {
    // Calculate delay between each user start
    delayBetweenUsers = Math.floor((rampUpTime * 1000) / (config.parallelUsers - 1));
    console.log(`   - Ramp-Up Time: ${rampUpTime}s (${delayBetweenUsers}ms between user starts)`);
  }
  
  if (config.testName) {
    console.log(`   - Test Name: ${config.testName}`);
  }
  
  console.log(`\n🚀 Launching ${config.parallelUsers} parallel users${rampUpTime > 0 ? ' with ramp-up' : ''}...\n`);
  
  // Launch users with optional ramp-up delay
  const userPromises = [];
  for (let userId = 1; userId <= config.parallelUsers; userId++) {
    // Add delay for ramp-up (except for first user)
    if (userId > 1 && delayBetweenUsers > 0) {
      console.log(`⏱️  Ramp-up: Starting User ${userId} after ${delayBetweenUsers}ms delay...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenUsers));
    }
    
    userPromises.push(runUserWorkload(userId, testFunction, config));
  }
  
  // Wait for all users to complete
  const userResults = await Promise.all(userPromises);
  
  // Calculate statistics
  const totalDuration = ((Date.now() - testStart) / 1000).toFixed(2);
  let totalExecutions = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  const allDurations = [];
  
  userResults.forEach(user => {
    totalExecutions += user.results.length;
    totalSuccesses += user.successCount;
    totalFailures += user.failureCount;
    
    user.results.forEach(result => {
      if (result.success && result.duration) {
        allDurations.push(result.duration);
      }
    });
  });
  
  // Print final summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 FINAL TEST SUMMARY`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Parallel Users: ${config.parallelUsers}`);
  console.log(`Iterations per User: ${config.iterations}`);
  console.log(`Total Executions: ${totalExecutions}`);
  console.log(`Total Successful: ${totalSuccesses} ✅`);
  console.log(`Total Failed: ${totalFailures} ❌`);
  console.log(`Overall Success Rate: ${((totalSuccesses / totalExecutions) * 100).toFixed(1)}%`);
  console.log(`Total Test Duration: ${totalDuration}s`);
  
  if (allDurations.length > 0) {
    const avgDuration = allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length;
    const minDuration = Math.min(...allDurations);
    const maxDuration = Math.max(...allDurations);
    
    console.log(`\nPerformance Metrics:`);
    console.log(`   - Average Duration: ${avgDuration.toFixed(2)}s`);
    console.log(`   - Min Duration: ${minDuration.toFixed(2)}s`);
    console.log(`   - Max Duration: ${maxDuration.toFixed(2)}s`);
    console.log(`   - Throughput: ${(totalExecutions / parseFloat(totalDuration)).toFixed(2)} tests/second`);
  }
  
  console.log(`${'='.repeat(70)}\n`);
  
  // Generate JTL result file for AWS upload (required by entrypoint.sh)
  generateJTLResultFile(userResults, totalExecutions, totalSuccesses, totalFailures);
  
  return {
    userResults,
    totalExecutions,
    totalSuccesses,
    totalFailures,
    totalDuration
  };
}

/**
 * Generate JTL (JMeter Test Log) result file for AWS S3 upload
 * This file is expected by docker/entrypoint.sh for result upload
 * Includes detailed transaction timing data from timedAction() calls
 * Uses CSV format for compatibility with merge-results Lambda
 * @param {Array} userResults - Results from all users
 * @param {number} totalExecutions - Total test executions
 * @param {number} totalSuccesses - Total successful tests
 * @param {number} totalFailures - Total failed tests
 */
function generateJTLResultFile(userResults, totalExecutions, totalSuccesses, totalFailures) {
  const fs = require('fs');
  const jtlPath = '/tmp/results-0.jtl';
  
  console.log('📝 Generating JTL result file for S3 upload...');
  
  // JTL CSV format (compatible with merge-results Lambda and JMeter)
  // Format: timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect
  let jtlContent = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect\n';
  
  let transactionCount = 0;
  
  // Use transaction data stored by timedAction() calls (includes detailed timing)
  if (global.jmeterTransactions && Object.keys(global.jmeterTransactions).length > 0) {
    console.log(`   - Using detailed transaction data from timedAction() calls`);
    
    Object.entries(global.jmeterTransactions).forEach(([userId, transactions]) => {
      transactions.forEach(txn => {
        transactionCount++;
        const duration = Math.round(txn.duration * 1000); // Convert to ms
        const timestamp = txn.timestamp || Date.now();
        const success = txn.success !== false; // Default to true if not specified
        const responseCode = success ? '200' : '500';
        const responseMessage = success ? 'OK' : (txn.error || 'Error');
        const threadName = `User ${userId}`;
        const failureMessage = success ? '' : (txn.error || 'Transaction failed');
        
        // CSV line: timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect
        jtlContent += `${timestamp},${duration},${txn.name},${responseCode},${responseMessage},${threadName},text,${success},${failureMessage},0,0,1,1,,${duration},0,0\n`;
      });
    });
  } else {
    // Fallback: Use simple results (for backward compatibility)
    console.log(`   - No transaction data found, using simple results`);
    
    userResults.forEach(userResult => {
      userResult.results.forEach(result => {
        transactionCount++;
        const timestamp = Date.now();
        const threadName = `User ${result.userId}`;
        const label = `User_${result.userId}_Iteration_${result.iteration}`;
        
        if (result.success) {
          const duration = result.duration ? Math.round(result.duration * 1000) : 0; // Convert to ms
          jtlContent += `${timestamp},${duration},${label},200,OK,${threadName},text,true,,0,0,1,1,,${duration},0,0\n`;
        } else {
          const errorMsg = result.error || 'Unknown error';
          jtlContent += `${timestamp},0,${label},500,Error,${threadName},text,false,${errorMsg},0,0,1,1,,0,0,0\n`;
        }
      });
    });
  }
  
  try {
    fs.writeFileSync(jtlPath, jtlContent);
    console.log(`✅ JTL result file saved: ${jtlPath}`);
    console.log(`   - Format: CSV (compatible with merge-results Lambda)`);
    console.log(`   - Transaction Samples: ${transactionCount}`);
    console.log(`   - Total Executions: ${totalExecutions}`);
    console.log(`   - Successful: ${totalSuccesses}`);
    console.log(`   - Failed: ${totalFailures}`);
    console.log(`   - This file will be uploaded to S3 by the container`);
  } catch (error) {
    console.error(`⚠️  Warning: Failed to write JTL file: ${error.message}`);
    console.error(`   Results will not be available in S3, but test execution completed`);
  }
}

module.exports = {
  timedAction,
  runParallelTest,
  TransactionTimer
};
