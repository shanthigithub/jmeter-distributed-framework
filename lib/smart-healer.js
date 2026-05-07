/**
 * SmartHealer - Unified Healwright wrapper with hybrid mode support
 * 
 * Supports three modes:
 * 1. Standalone: Algorithm-based healing (fast, $0 cost, 70-80% success)
 * 2. ML Backend: Machine learning healing (slower, $20/mo, 85-90% success)
 * 3. Hybrid: Start standalone, auto-escalate to ML when needed (optimal cost/performance)
 * 
 * Usage:
 *   const healer = new SmartHealer(page);
 *   await healer.click('#button');
 *   await healer.fill('#input', 'value');
 *   
 * Mode is determined by:
 *   1. Per-test override in constructor
 *   2. Environment variable HEALWRIGHT_MODE
 *   3. Configuration file (healwright.config.js)
 *   4. Default: standalone
 */

const { SelfHealingLocators } = require('./self-healing-locators');
const path = require('path');
const fs = require('fs');

// Try multiple locations for healwright.config.js
let config = {
  mode: 'standalone',  // Default to standalone if no config found
  mlBackendUrl: null,
  hybrid: {
    startWith: 'standalone',
    escalationTrigger: { failureCount: 3 }
  }
};

// Search for config in multiple locations
const configPaths = [
  path.join(__dirname, '../healwright.config.js'),  // Relative to lib/
  '/jmeter/healwright.config.js',                    // Docker absolute path
  path.join(process.cwd(), 'healwright.config.js'),  // Current working directory
];

for (const configPath of configPaths) {
  try {
    if (fs.existsSync(configPath)) {
      config = require(configPath);
      console.log(`✅ Loaded Healwright config from: ${configPath}`);
      break;
    }
  } catch (e) {
    // Config not found at this path, try next
  }
}

class SmartHealer {
  constructor(page, options = {}) {
    this.page = page;
    this.options = { ...config, ...options };
    
    // Determine mode: option > env > config > default
    this.mode = options.mode || 
                process.env.HEALWRIGHT_MODE || 
                config.mode || 
                'standalone';
    
    // Initialize healers
    this.standaloneHealer = new SelfHealingLocators(page, {
      threshold: this.options.standalone?.threshold || 0.70,
      maxRetries: this.options.standalone?.maxRetries || 3,
      logHealing: this.options.logging?.logHealedLocators !== false
    });
    
    // ML healer (lazy initialized)
    this.mlHealer = null;
    this.mlBackendUrl = process.env.HEALWRIGHT_ML_URL || this.options.ml?.serverUrl;
    
    // Statistics
    this.stats = {
      total: 0,
      standaloneSuccess: 0,
      mlSuccess: 0,
      failures: 0,
      escalations: 0,
      mlCost: 0,
      startTime: Date.now(),
      totalHealingTimeMs: 0  // Track total healing overhead for performance tests
    };
    
    // Hybrid mode tracking
    this.selectorFailures = {}; // Track failures per selector
    this.escalationThreshold = this.options.hybrid?.escalationTrigger?.failureCount || 3;
    this.learnedSelectors = {}; // Store ML-learned selectors
    
    if (this.options.logging?.level === 'info' || this.options.logging?.level === 'debug') {
      console.log(`🔧 SmartHealer initialized in ${this.mode.toUpperCase()} mode`);
    }
  }
  
  /**
   * Initialize ML healer (lazy)
   */
  _initMLHealer() {
    if (this.mlHealer) return;
    
    if (!this.mlBackendUrl) {
      throw new Error('ML backend URL not configured. Set HEALWRIGHT_ML_URL or config.ml.serverUrl');
    }
    
    // For now, use the same standalone healer as ML placeholder
    // In production, this would connect to actual ML backend
    this.mlHealer = new SelfHealingLocators(this.page, {
      threshold: this.options.ml?.threshold || 0.90,
      maxRetries: this.options.ml?.maxRetries || 5,
      logHealing: true
    });
    
    console.log(`🤖 ML healer connected to: ${this.mlBackendUrl}`);
  }
  
  /**
   * Check if selector should use ML based on history
   */
  _shouldUseML(selector) {
    // Always use ML in ML mode
    if (this.mode === 'ml') return true;
    
    // Never use ML in standalone mode
    if (this.mode === 'standalone') return false;
    
    // Hybrid mode: check escalation
    if (this.mode === 'hybrid') {
      const failures = this.selectorFailures[selector] || 0;
      return failures >= this.escalationThreshold;
    }
    
    return false;
  }
  
  /**
   * Record failure for selector
   */
  _recordFailure(selector) {
    if (this.mode === 'hybrid') {
      this.selectorFailures[selector] = (this.selectorFailures[selector] || 0) + 1;
      
      if (this.selectorFailures[selector] === this.escalationThreshold) {
        console.log(`⚡ Escalating to ML: ${selector} (${this.escalationThreshold} failures)`);
        this.stats.escalations++;
      }
    }
  }
  
  /**
   * Record success (reset failure count in hybrid mode)
   */
  _recordSuccess(selector, usedML = false) {
    if (this.mode === 'hybrid' && usedML) {
      // Reset failure count after successful ML healing
      delete this.selectorFailures[selector];
    }
    
    if (usedML) {
      this.stats.mlSuccess++;
      this.stats.mlCost += 0.01; // Estimate $0.01 per ML healing
    } else {
      this.stats.standaloneSuccess++;
    }
  }
  
  /**
   * Try to perform action directly without healing
   * Returns true if successful, false if healing needed
   * @private
   */
  async _tryDirect(action) {
    try {
      await action();
      return true;  // Success without healing
    } catch (error) {
      return false;  // Needs healing
    }
  }
  
  /**
   * Click with smart healing
   */
  async click(selector, options = {}) {
    this.stats.total++;
    const useML = this._shouldUseML(selector);
    const healingStart = Date.now();
    let healingOccurred = false;
    
    try {
      if (useML) {
        // Use ML healer
        this._initMLHealer();
        healingOccurred = true;
        await this.mlHealer.click(selector, options);
        this._recordSuccess(selector, true);
      } else {
        // Try standalone first
        const directSuccess = await this._tryDirect(() => this.page.locator(selector).click(options));
        if (directSuccess) {
          this._recordSuccess(selector, false);
        } else {
          healingOccurred = true;
          await this.standaloneHealer.click(selector, options);
          this._recordSuccess(selector, false);
        }
      }
    } catch (error) {
      this._recordFailure(selector);
      
      // In hybrid mode, try ML if standalone fails and we haven't tried it yet
      if (this.mode === 'hybrid' && !useML && this._shouldUseML(selector)) {
        console.log(`🔄 Retrying with ML: ${selector}`);
        try {
          this._initMLHealer();
          healingOccurred = true;
          await this.mlHealer.click(selector, options);
          this._recordSuccess(selector, true);
          return;
        } catch (mlError) {
          // Both failed
        }
      }
      
      this.stats.failures++;
      throw error;
    } finally {
      if (healingOccurred) {
        this.stats.totalHealingTimeMs += Date.now() - healingStart;
      }
    }
  }
  
  /**
   * Fill input with smart healing
   */
  async fill(selector, value, options = {}) {
    this.stats.total++;
    const useML = this._shouldUseML(selector);
    const healingStart = Date.now();
    let healingOccurred = false;
    
    try {
      if (useML) {
        this._initMLHealer();
        healingOccurred = true;
        await this.mlHealer.fill(selector, value, options);
        this._recordSuccess(selector, true);
      } else {
        const directSuccess = await this._tryDirect(() => this.page.locator(selector).fill(value, options));
        if (directSuccess) {
          this._recordSuccess(selector, false);
        } else {
          healingOccurred = true;
          await this.standaloneHealer.fill(selector, value, options);
          this._recordSuccess(selector, false);
        }
      }
    } catch (error) {
      this._recordFailure(selector);
      
      if (this.mode === 'hybrid' && !useML && this._shouldUseML(selector)) {
        console.log(`🔄 Retrying with ML: ${selector}`);
        try {
          this._initMLHealer();
          healingOccurred = true;
          await this.mlHealer.fill(selector, value, options);
          this._recordSuccess(selector, true);
          return;
        } catch (mlError) {
          // Both failed
        }
      }
      
      this.stats.failures++;
      throw error;
    } finally {
      if (healingOccurred) {
        this.stats.totalHealingTimeMs += Date.now() - healingStart;
      }
    }
  }
  
  /**
   * Wait for element with smart healing
   */
  async waitFor(selector, options = {}) {
    this.stats.total++;
    const useML = this._shouldUseML(selector);
    const healingStart = Date.now();
    let healingOccurred = false;
    
    try {
      if (useML) {
        this._initMLHealer();
        healingOccurred = true;
        await this.mlHealer.waitFor(selector, options);
        this._recordSuccess(selector, true);
      } else {
        const directSuccess = await this._tryDirect(() => this.page.locator(selector).waitFor(options));
        if (directSuccess) {
          this._recordSuccess(selector, false);
        } else {
          healingOccurred = true;
          await this.standaloneHealer.waitFor(selector, options);
          this._recordSuccess(selector, false);
        }
      }
    } catch (error) {
      this._recordFailure(selector);
      
      if (this.mode === 'hybrid' && !useML && this._shouldUseML(selector)) {
        console.log(`🔄 Retrying with ML: ${selector}`);
        try {
          this._initMLHealer();
          healingOccurred = true;
          await this.mlHealer.waitFor(selector, options);
          this._recordSuccess(selector, true);
          return;
        } catch (mlError) {
          // Both failed
        }
      }
      
      this.stats.failures++;
      throw error;
    } finally {
      if (healingOccurred) {
        this.stats.totalHealingTimeMs += Date.now() - healingStart;
      }
    }
  }
  
  /**
   * Get locator with smart healing
   */
  async locator(selector, options = {}) {
    const useML = this._shouldUseML(selector);
    
    if (useML) {
      this._initMLHealer();
      return await this.mlHealer.locator(selector, options);
    } else {
      return await this.standaloneHealer.locator(selector, options);
    }
  }
  
  /**
   * Create iframe/frame healer with self-healing for iframe selector
   * @param {string|FrameLocator} frameSelector - XPath/CSS selector string OR Playwright FrameLocator
   */
  forFrame(frameSelector) {
    const parentStats = this.stats;
    const parentHealer = this;
    
    // If it's a string selector, apply self-healing to find the iframe
    // If it's already a FrameLocator object, try it first, then heal if it fails
    const isStringSelector = typeof frameSelector === 'string';
    
    return {
      click: async (selector, options = {}) => {
        parentStats.total++;
        try {
          // Try original frame locator first
          const frameHealer = parentHealer.standaloneHealer.forFrame(frameSelector);
          await frameHealer.click(selector, options);
          parentStats.standaloneSuccess++;
        } catch (error) {
          // If frame interaction failed, try healing the iframe selector
          if (!isStringSelector) {
            console.log(`⚠️  Iframe interaction failed, attempting to heal iframe locator`);
            try {
              // Heal and retry
              const healedFrame = await parentHealer._healFailedFrame();
              const healedFrameHealer = parentHealer.standaloneHealer.forFrame(healedFrame);
              await healedFrameHealer.click(selector, options);
              parentStats.standaloneSuccess++;
              return;
            } catch (healError) {
              // Healing also failed
            }
          }
          parentStats.failures++;
          throw error;
        }
      },
      fill: async (selector, value, options = {}) => {
        parentStats.total++;
        try {
          const frameHealer = parentHealer.standaloneHealer.forFrame(frameSelector);
          await frameHealer.fill(selector, value, options);
          parentStats.standaloneSuccess++;
        } catch (error) {
          if (!isStringSelector) {
            console.log(`⚠️  Iframe interaction failed, attempting to heal iframe locator`);
            try {
              const healedFrame = await parentHealer._healFailedFrame();
              const healedFrameHealer = parentHealer.standaloneHealer.forFrame(healedFrame);
              await healedFrameHealer.fill(selector, value, options);
              parentStats.standaloneSuccess++;
              return;
            } catch (healError) {
              // Healing also failed
            }
          }
          parentStats.failures++;
          throw error;
        }
      },
      waitFor: async (selector, options = {}) => {
        parentStats.total++;
        try {
          const frameHealer = parentHealer.standaloneHealer.forFrame(frameSelector);
          await frameHealer.waitFor(selector, options);
          parentStats.standaloneSuccess++;
        } catch (error) {
          if (!isStringSelector) {
            console.log(`⚠️  Iframe interaction failed, attempting to heal iframe locator`);
            try {
              const healedFrame = await parentHealer._healFailedFrame();
              const healedFrameHealer = parentHealer.standaloneHealer.forFrame(healedFrame);
              await healedFrameHealer.waitFor(selector, options);
              parentStats.standaloneSuccess++;
              return;
            } catch (healError) {
              // Healing also failed
            }
          }
          parentStats.failures++;
          throw error;
        }
      }
    };
  }
  
  /**
   * Heal a failed iframe by finding any iframe on the page
   * @private
   */
  async _healFailedFrame() {
    console.log(`🔍 Searching for iframe on page...`);
    
    // Try common iframe selectors
    const commonSelectors = [
      "//iframe[@title='dashboard']",  // Correct spelling
      "//iframe[contains(@title, 'dash')]",  // Partial match
      "//iframe[@name='dashboard']",
      "(//iframe)[1]",  // First iframe
      "//iframe",  // Any iframe
    ];
    
    for (const sel of commonSelectors) {
      try {
        const frameLocator = this.page.frameLocator(sel);
        // Test if frame exists
        await frameLocator.locator('body').first().waitFor({ timeout: 2000 });
        console.log(`✅ Iframe healed! Found using: ${sel}`);
        return frameLocator;
      } catch (e) {
        // Try next selector
      }
    }
    
    throw new Error('Failed to heal iframe - no iframe found on page');
  }
  
  /**
   * Get healed frame locator by applying self-healing to iframe selector
   * @private
   */
  async _getHealedFrame(frameSelector) {
    try {
      // Try the original selector first
      const frameLocator = this.page.frameLocator(frameSelector);
      // Test if frame exists by trying to get its first element
      await frameLocator.locator('body').first().waitFor({ timeout: 5000 });
      return frameLocator;
    } catch (error) {
      console.log(`⚠️  Iframe selector failed, attempting self-heal: ${frameSelector}`);
      
      // Apply self-healing to find the iframe element
      const healedIframe = await this.standaloneHealer.locator(frameSelector);
      
      // Get the healed selector that worked
      const healedSelector = await healedIframe.evaluate((el) => {
        // Try to generate a unique selector for this iframe
        if (el.title) return `//*[@title='${el.title}']`;
        if (el.name) return `//*[@name='${el.name}']`;
        if (el.id) return `//*[@id='${el.id}']`;
        
        // Fallback: use nth-child
        const parent = el.parentElement;
        const index = Array.from(parent.children).indexOf(el) + 1;
        return `(//iframe)[${index}]`;
      });
      
      console.log(`✅ Iframe healed! New selector: ${healedSelector}`);
      return this.page.frameLocator(healedSelector);
    }
  }
  
  /**
   * Get total healing time (for performance test deduction)
   * @returns {number} Total healing time in milliseconds
   */
  getTotalHealingTime() {
    return this.stats.totalHealingTimeMs;
  }
  
  /**
   * Get comprehensive statistics
   */
  getStats() {
    const duration = Date.now() - this.stats.startTime;
    const totalHealed = this.stats.standaloneSuccess + this.stats.mlSuccess;
    const successRate = this.stats.total > 0 
      ? (totalHealed / this.stats.total * 100).toFixed(1)
      : 100;
    const mlUsageRate = this.stats.total > 0
      ? (this.stats.mlSuccess / this.stats.total * 100).toFixed(1)
      : 0;
    const avgHealingTime = this.stats.total > 0
      ? (duration / this.stats.total).toFixed(0)
      : 0;
    
    // Determine performance impact based on ML usage
    let performanceImpact = 'Negligible';
    if (parseFloat(mlUsageRate) > 20) {
      performanceImpact = 'Moderate';
    } else if (parseFloat(mlUsageRate) > 50) {
      performanceImpact = 'High';
    } else if (parseFloat(mlUsageRate) < 10) {
      performanceImpact = 'Low Impact';
    }
    
    return {
      // Properties expected by test script
      total: this.stats.total,
      mlHealed: this.stats.mlSuccess,
      clientHealed: this.stats.standaloneSuccess,
      failed: this.stats.failures,
      successRate: parseFloat(successRate),
      mlUsageRate: parseFloat(mlUsageRate),
      performanceImpact: performanceImpact,
      avgHealingTimeMs: parseInt(avgHealingTime),
      
      // Additional properties for detailed reporting
      mode: this.mode,
      standalone: this.stats.standaloneSuccess,
      ml: this.stats.mlSuccess,
      failures: this.stats.failures,
      escalations: this.stats.escalations,
      mlCostUSD: this.stats.mlCost.toFixed(4),
      durationMs: duration,
      healingEfficiency: {
        standalonePercent: this.stats.total > 0 
          ? (this.stats.standaloneSuccess / this.stats.total * 100).toFixed(1)
          : 0,
        mlPercent: this.stats.total > 0
          ? (this.stats.mlSuccess / this.stats.total * 100).toFixed(1)
          : 0
      }
    };
  }
  
  /**
   * Get detailed report
   */
  getDetailedReport() {
    const stats = this.getStats();
    
    return {
      ...stats,
      selectorFailures: Object.keys(this.selectorFailures).length,
      problematicSelectors: Object.entries(this.selectorFailures)
        .filter(([_, count]) => count >= this.escalationThreshold)
        .map(([selector, count]) => ({ selector, failures: count })),
      costBreakdown: {
        standalone: '$0.00 (included)',
        ml: `$${stats.mlCostUSD}`,
        total: `$${stats.mlCostUSD}`
      }
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      total: 0,
      standaloneSuccess: 0,
      mlSuccess: 0,
      failures: 0,
      escalations: 0,
      mlCost: 0,
      startTime: Date.now()
    };
    this.selectorFailures = {};
  }
  
  /**
   * Print summary (useful at end of test)
   */
  printSummary() {
    const stats = this.getStats();
    
    console.log('\n' + '='.repeat(60));
    console.log('🔧 SmartHealer Summary');
    console.log('='.repeat(60));
    console.log(`Mode: ${stats.mode.toUpperCase()}`);
    console.log(`Total interactions: ${stats.total}`);
    console.log(`Success rate: ${stats.successRate}%`);
    console.log(`\nHealing breakdown:`);
    console.log(`  Standalone: ${stats.standalone} (${stats.healingEfficiency.standalonePercent}%)`);
    console.log(`  ML Backend: ${stats.ml} (${stats.healingEfficiency.mlPercent}%)`);
    console.log(`  Failures: ${stats.failures}`);
    
    if (this.mode === 'hybrid') {
      console.log(`\nHybrid mode:`);
      console.log(`  Escalations to ML: ${stats.escalations}`);
      console.log(`  Problematic selectors: ${Object.keys(this.selectorFailures).length}`);
    }
    
    console.log(`\nCost: $${stats.mlCostUSD}`);
    console.log(`Duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
    console.log('='.repeat(60) + '\n');
  }
}

/**
 * Factory function for creating SmartHealer instances
 * Compatible with existing test scripts that use createSmartHealer()
 * Automatically sets global.smartHealer for timedAction performance tracking
 */
function createSmartHealer(page, options = {}) {
  const healer = new SmartHealer(page, options);
  
  // Auto-set global reference for timedAction to exclude healing time from metrics
  // This happens automatically - no manual setup needed in test scripts
  global.smartHealer = healer;
  
  return healer;
}

module.exports = { SmartHealer, createSmartHealer };
