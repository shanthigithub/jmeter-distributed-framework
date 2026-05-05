// Healwright Configuration
// AI-powered self-healing locators for Playwright
// Similar to Healenium for Selenium, but for Playwright tests

module.exports = {
  // Enable healwright
  enabled: true,
  
  // Healing mode: 'standalone', 'ml', or 'hybrid'
  // - standalone: Algorithm-based healing (fast, $0 cost, 70-80% success)
  // - ml: ML backend healing (slower, $20/mo, 85-90% success)
  // - hybrid: Start standalone, auto-escalate to ML (optimal, $3-5/mo avg)
  mode: process.env.HEALWRIGHT_MODE || 'hybrid',
  
  // Standalone healing configuration
  standalone: {
    // Similarity threshold for finding similar elements (0-1)
    // Higher = more strict matching, lower = more flexible
    threshold: 0.70,
    
    // Maximum number of alternatives to try
    maxAlternatives: 5,
    
    // Maximum retry attempts
    maxRetries: 3,
    
    // Enable visual similarity matching
    useVisualMatching: true,
    
    // Enable text content matching
    useTextMatching: true,
    
    // Enable position-based matching
    usePositionMatching: true
  },
  
  // ML backend configuration (used in 'ml' or 'hybrid' modes)
  ml: {
    // ML backend server URL
    serverUrl: process.env.HEALWRIGHT_ML_URL || 'http://healwright-backend:3000',
    
    // API key for authentication (if required)
    apiKey: process.env.HEALWRIGHT_API_KEY,
    
    // Higher threshold for ML (more accurate)
    threshold: 0.90,
    
    // Maximum retry attempts
    maxRetries: 5,
    
    // Enable learning from successful healings
    enableLearning: true,
    
    // Connection timeout (ms)
    timeout: 10000
  },
  
  // Hybrid mode configuration
  hybrid: {
    // Start with this mode
    startWith: 'standalone',
    
    // Escalate to this mode when standalone fails
    escalateTo: 'ml',
    
    // Escalation trigger
    escalationTrigger: {
      // Number of failures before escalating
      failureCount: 3,
      
      // Time window for failure counting (not implemented yet)
      timeWindow: '1h'
    },
    
    // Reset failure count after successful ML healing
    resetOnSuccess: true,
    
    // Maximum ML calls per test
    maxMLCallsPerTest: 20
  },
  
  // Logging configuration
  logging: {
    // Log level: 'debug', 'info', 'warn', 'error'
    level: 'info',
    
    // Log healed locators
    logHealedLocators: true,
    
    // Log file path (relative to project root)
    logFile: '/jmeter/results/healwright.log'
  },
  
  // Reporting configuration
  reporting: {
    // Save healing reports
    enabled: true,
    
    // Report output directory
    outputDir: '/jmeter/results/healwright-reports',
    
    // Report format: 'json', 'html', 'both'
    format: 'json'
  },
  
  // Cost optimization
  costOptimization: {
    // Maximum ML calls per day (to control costs)
    maxMLCallsPerDay: 100,
    
    // Alert when approaching limit
    alertThreshold: 0.8, // 80% of maxMLCallsPerDay
    
    // Disable ML when budget exceeded
    disableMLWhenBudgetExceeded: true
  },
  
  // Recovery configuration
  recovery: {
    // Auto-update test files with healed locators
    autoUpdate: false,
    
    // Require manual approval before healing
    requireApproval: false,
    
    // Maximum healing attempts per locator
    maxAttempts: 3
  },
  
  // Selector preferences (in order of preference)
  selectorPreferences: [
    'data-testid',
    'id',
    'aria-label',
    'text',
    'css',
    'xpath'
  ]
};