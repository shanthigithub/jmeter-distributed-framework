/**
 * JMeter ECS Framework Configuration
 * 
 * Simple, environment-agnostic configuration.
 * Personal AWS account optimized for cost and performance.
 */

export const config = {
  // AWS Account (will be automatically detected from CDK context)
  region: 'us-east-1',
  
  // S3 Buckets (suffixed with account ID for global uniqueness)
  // CDK will automatically replace ${AWS::AccountId} with actual account ID
  configBucket: 'jmeter-framework-config-${AWS::AccountId}',
  resultsBucket: 'jmeter-framework-results-${AWS::AccountId}',
  
  // ECR (suffixed with account ID)
  ecrRepoName: 'jmeter-framework-${AWS::AccountId}',
  
  // ECS Fargate Configuration
  ecs: {
    // API Task Configuration (Lightweight - HTTP/REST)
    apiTask: {
      vcpus: 2,               // 2 vCPU per task
      memoryMiB: 4096,        // 4 GB RAM per task
      retryAttempts: 3,       // Retry failed tasks 3 times
      timeoutMinutes: 120,    // 2 hour timeout per task
    },
    // Browser Task Configuration (Heavy - Selenium/JSR223)
    browserTask: {
      vcpus: 4,               // 4 vCPU per task (2x API)
      memoryMiB: 8192,        // 8 GB RAM per task (2x API)
      retryAttempts: 3,       // Retry failed tasks 3 times
      timeoutMinutes: 240,    // 4 hour timeout (browser tests slower)
    },
  },
  
  // Lambda Configuration
  lambda: {
    runtime: 'PYTHON_3_12' as const,
    architecture: 'ARM_64' as const,  // 20% cheaper than x86
    memoryMB: 512,
    timeoutSeconds: {
      readConfig: 60, // 1 minute
      submitTasks: 300,      // 5 minutes
      checkTasks: 30,        // 30 seconds (fast check only)
      mergeResults: 600,     // 10 minutes (result aggregation can be slow)
    },
  },
  
  // Step Functions Configuration
  stepFunctions: {
    timeoutMinutes: 240,     // 4 hours max per test run
    waitBetweenChecks: 60,   // Poll task status every 60 seconds
  },
  
  // CloudWatch Logs
  logs: {
    retentionDays: 7,        // 1 week retention
  },
  
  // Security
  security: {
    enableEncryption: true,
    enableVpcEndpoints: false,  // Set true for production (extra cost)
  },
  
  // Monitoring
  monitoring: {
    enableDatadog: false,    // Optional: Enable Datadog integration
    datadogSite: 'datadoghq.com',
    // Datadog API key from AWS Secrets Manager
    datadogSecretArn: 'arn:aws:secretsmanager:us-east-1:623035187488:secret:datadog/personal-api-key-rt1vuN',
  },
};

/**
 * Test Suite Configuration Schema
 * 
 * Example test suite JSON structure expected in S3:
 * {
 *   "testSuite": [
 *     {
 *       "testId": "api-load-test",
 *       "testType": "api",
 *       "testScript": "tests/api-load.jmx",
 *       "numOfContainers": 3,
 *       "threads": 100,
 *       "duration": "15m",
 *       "dataFiles": ["data/users.csv", "data/products.csv"],
 *       "execute": true
 *     },
 *     {
 *       "testId": "browser-selenium-test",
 *       "testType": "browser",
 *       "testScript": "tests/browser/ui-flow.jmx",
 *       "numOfContainers": 2,
 *       "threads": 10,
 *       "duration": "30m",
 *       "execute": true
 *     }
 *   ]
 * }
 */
export interface TestConfig {
  testId: string;
  testType?: 'api' | 'browser';  // Test type (defaults to 'api')
  testScript: string;
  numOfContainers: number;
  threads: number;
  duration: string;
  dataFiles?: string[];
  execute: boolean;
  jvmArgs?: string;  // Optional JVM arguments
  jmeterProperties?: Record<string, string>;  // Optional JMeter properties
}

export interface TestSuite {
  testSuite: TestConfig[];
}