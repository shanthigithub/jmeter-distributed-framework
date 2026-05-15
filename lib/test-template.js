/**
 * Test Template - Copy this to create new tests
 * 
 * How to use:
 * 1. Copy this file to tests/your-test-name.js
 * 2. Update the config section with your test parameters
 * 3. Implement the runUser() function with your test steps
 * 4. Run: node tests/your-test-name.js
 * 
 * The test runner framework handles:
 * - Parallel user execution
 * - Sequential iterations per user
 * - Statistics collection
 * - Performance metrics
 * - Exit codes for CI/CD
 */

const { runParallelTest, timedAction } = require('../lib/test-runner');

// ============================================================================
// CONFIGURATION - Customize for your test
// ============================================================================
const config = {
  // Test metadata
  testName: 'My Test Name',
  
  // Load testing parameters
  parallelUsers: parseInt(process.env.PARALLEL_USERS || '5'),
  iterations: parseInt(process.env.ITERATIONS || '3'),
  thinkTime: parseInt(process.env.THINK_TIME || '2000'),
  
  // Test-specific configuration (add your own here)
  baseUrl: process.env.BASE_URL || 'https://example.com',
  apiKey: process.env.API_KEY || 'your-api-key',
  
  // Timeouts
  defaultTimeout: 30000,
  
  // Datadog tags (for metrics tracking)
  datadogTags: {
    testId: 'your-test-id',
    testType: 'api', // or 'browser', 'mixed'
    app: 'your-app',
    environment: 'test',
    priority: 'medium'
  }
};

// ============================================================================
// TEST IMPLEMENTATION - Add your test logic here
// ============================================================================

/**
 * Run a single user's test iteration
 * 
 * This function is called by the test runner for each user/iteration combination.
 * For example, with 10 users and 3 iterations, this will be called 30 times total.
 * 
 * @param {number} userId - User identifier (1 to parallelUsers)
 * @param {number} iterationNumber - Iteration number (1 to iterations)
 * @returns {Object} Test result with success status and timing data
 */
async function runUser(userId, iterationNumber) {
  const userStart = Date.now();
  console.log(`\n👤 User ${userId}: Starting iteration ${iterationNumber}`);
  
  const actionTimings = []; // Store timing data for each action
  
  try {
    // ========================================================================
    // STEP 1: Example action - Replace with your actual test steps
    // ========================================================================
    console.log('Step 1: Performing action 1...');
    const step1 = await timedAction(userId, 'Action 1 Description', async () => {
      // Your code here
      // Example: await fetch(config.baseUrl + '/api/endpoint');
      await new Promise(resolve => setTimeout(resolve, 100)); // Simulate work
      
      return { data: 'result from step 1' };
    });
    actionTimings.push(step1);
    
    // ========================================================================
    // STEP 2: Example action - Add more steps as needed
    // ========================================================================
    console.log('Step 2: Performing action 2...');
    const step2 = await timedAction(userId, 'Action 2 Description', async () => {
      // Your code here
      await new Promise(resolve => setTimeout(resolve, 100)); // Simulate work
      
      return { data: 'result from step 2' };
    });
    actionTimings.push(step2);
    
    // ========================================================================
    // STEP 3: Add more steps...
    // ========================================================================
    console.log('Step 3: Performing action 3...');
    const step3 = await timedAction(userId, 'Action 3 Description', async () => {
      // Your code here
      await new Promise(resolve => setTimeout(resolve, 100)); // Simulate work
      
      return { data: 'result from step 3' };
    });
    actionTimings.push(step3);
    
    // ========================================================================
    // SUCCESS - Return test results
    // ========================================================================
    const duration = ((Date.now() - userStart) / 1000).toFixed(2);
    console.log(`✅ User ${userId}: Iteration ${iterationNumber} completed in ${duration}s`);
    
    // Print action timing summary
    console.log(`\n📊 Action Timings for User ${userId}, Iteration ${iterationNumber}:`);
    actionTimings.forEach((timing, index) => {
      console.log(`   ${index + 1}. ${timing.action}: ${timing.elapsed}ms`);
    });
    
    return {
      success: true,
      userId: userId,
      iteration: iterationNumber,
      duration: parseFloat(duration),
      actionTimings: actionTimings,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    // ========================================================================
    // ERROR - Return failure details
    // ========================================================================
    console.error(`❌ User ${userId}: Iteration ${iterationNumber} failed: ${error.message}`);
    
    return {
      success: false,
      userId: userId,
      iteration: iterationNumber,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ============================================================================
// MAIN EXECUTION - Don't modify this section
// ============================================================================

/**
 * Main test execution
 * Uses the test runner framework to:
 * - Launch parallel users
 * - Run sequential iterations per user
 * - Collect and display statistics
 * - Exit with appropriate code for CI/CD
 */
async function main() {
  console.log('🚀 Starting Test: ' + config.testName);
  console.log('📊 Configuration:');
  console.log(`   - Test ID: ${config.datadogTags.testId}`);
  console.log(`   - Test Type: ${config.datadogTags.testType}`);
  console.log(`   - Environment: ${config.datadogTags.environment}`);
  console.log(`   - Parallel Users: ${config.parallelUsers}`);
  console.log(`   - Iterations: ${config.iterations}`);
  console.log(`   - Think Time: ${config.thinkTime}ms\n`);
  
  const results = await runParallelTest(runUser, config);
  
  // CRITICAL: DO NOT call process.exit() here!
  // The script must complete naturally so entrypoint.sh can upload results to S3.
  // Entrypoint.sh will detect the Node.js exit code automatically.
  const exitCode = results.totalFailures > 0 ? 1 : 0;
  console.log(`[EXIT] Test completed with exit code ${exitCode} - returning to entrypoint.sh for upload`);
  
  return results;
}

// Run the test
main();