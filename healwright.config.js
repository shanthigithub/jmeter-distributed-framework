// Healwright Configuration
// AI-powered self-healing locators for Playwright
// Similar to Healenium for Selenium, but for Playwright tests

module.exports = {
  // Enable healwright
  enabled: true,
  
  // Healing strategy
  strategy: {
    // Similarity threshold for finding similar elements (0-1)
    // Higher = more strict matching, lower = more flexible
    threshold: 0.7,
    
    // Maximum number of alternatives to try
    maxAlternatives: 5,
    
    // Enable visual similarity matching
    useVisualMatching: true,
    
    // Enable text content matching
    useTextMatching: true,
    
    // Enable position-based matching
    usePositionMatching: true
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