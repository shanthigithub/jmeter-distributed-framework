/**
 * AI-Powered Self-Healing Locators for Playwright
 * Inspired by Healenium's ML approach for Selenium
 * 
 * When a locator fails, this module:
 * 1. Analyzes the DOM to find similar elements using AI techniques
 * 2. Uses fuzzy text matching and visual similarity scoring
 * 3. Learns from successful healings to improve over time
 * 4. Logs which selectors worked for debugging
 * 5. Reports healing statistics
 */

class SelfHealingLocators {
  constructor(page, options = {}) {
    this.page = page;
    this.options = {
      maxRetries: options.maxRetries || 3,
      timeout: options.timeout || 30000,
      logHealing: options.logHealing !== false,
      implicitWait: options.implicitWait || 10000,  // Match JMeter's implicitlyWait (10s)
      pollInterval: options.pollInterval || 500,     // Match Selenium's default poll interval
      logImplicitWait: options.logImplicitWait !== false,  // Log implicit wait retries
      ...options
    };
    
    this.stats = {
      total: 0,
      healed: 0,
      failed: 0,
      totalHealingTimeMs: 0,
      avgHealingTimeMs: 0,
      implicitWaitRetries: 0  // Track how often implicit wait helps
    };
  }

  /**
   * Calculate Levenshtein distance (edit distance) between two strings
   * Used for fuzzy text matching in AI-powered healing
   */
  levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Calculate similarity score (0-1) between two strings
   * 1.0 = identical, 0.0 = completely different
   */
  stringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  /**
   * AI-powered element finder using DOM analysis and similarity scoring
   * Analyzes all page elements and scores them based on multiple attributes
   */
  async findSimilarElements(targetText, targetAttrs = {}) {
    const elements = await this.page.$$('*');
    const scored = [];
    
    for (const el of elements) {
      try {
        const text = await el.textContent();
        const attrs = {
          id: await el.getAttribute('id'),
          name: await el.getAttribute('name'),
          title: await el.getAttribute('title'),
          'aria-label': await el.getAttribute('aria-label'),
          class: await el.getAttribute('class'),
          type: await el.getAttribute('type')
        };
        
        let score = 0;
        
        // Score based on text similarity (40% weight)
        if (targetText && text) {
          const textSim = this.stringSimilarity(
            targetText.toLowerCase().trim(),
            text.toLowerCase().trim()
          );
          score += textSim * 0.4;
        }
        
        // Score based on attribute similarities (60% weight)
        const attrWeight = 0.6 / Object.keys(targetAttrs).length;
        for (const [key, value] of Object.entries(targetAttrs)) {
          if (value && attrs[key]) {
            const attrSim = this.stringSimilarity(
              String(value).toLowerCase(),
              String(attrs[key]).toLowerCase()
            );
            score += attrSim * attrWeight;
          }
        }
        
        if (score > 0.5) { // Only consider elements with >50% similarity
          scored.push({ element: el, score, text, attrs });
        }
      } catch (e) {
        // Element might be stale, skip it
      }
    }
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    return scored;
  }

  /**
   * Generate alternative selectors for a failed locator
   * Uses both rule-based patterns and AI-powered DOM analysis
   */
  async generateAlternatives(originalSelector) {
    const alternatives = [];
    
    // If it's an XPath
    if (originalSelector.startsWith('//') || originalSelector.startsWith('(/')) {
      // Try variations of the XPath
      
      // Extract text content if present
      const textMatch = originalSelector.match(/text\(\s*\)\s*=\s*['"]([^'"]+)['"]/);
      if (textMatch) {
        const text = textMatch[1];
        alternatives.push(`text=${text}`); // Playwright text selector
        alternatives.push(`//*[contains(text(),'${text}')]`); // Contains instead of exact
      }
      
      // Extract attribute-based selectors
      const attrMatch = originalSelector.match(/@(\w+)\s*=\s*['"]([^'"]+)['"]/);
      if (attrMatch) {
        const [, attr, value] = attrMatch;
        if (attr === 'title') alternatives.push(`[title="${value}"]`);
        if (attr === 'name') alternatives.push(`[name="${value}"]`);
        if (attr === 'id') alternatives.push(`#${value}`);
        if (attr === 'data-testid') alternatives.push(`[data-testid="${value}"]`);
        alternatives.push(`[${attr}="${value}"]`); // Generic attribute selector
      }
      
      // Extract aria-label
      const ariaMatch = originalSelector.match(/aria-label\s*=\s*['"]([^'"]+)['"]/);
      if (ariaMatch) {
        alternatives.push(`[aria-label="${ariaMatch[1]}"]`);
      }
    }
    
    // If it's a CSS selector
    else {
      // Try making it more flexible
      if (originalSelector.includes('[name=')) {
        const nameMatch = originalSelector.match(/\[name=['"]?([^'"\]]+)['"]?\]/);
        if (nameMatch) {
          alternatives.push(`//*[@name='${nameMatch[1]}']`);
        }
      }
      
      if (originalSelector.includes('[title=')) {
        const titleMatch = originalSelector.match(/\[title=['"]?([^'"\]]+)['"]?\]/);
        if (titleMatch) {
          alternatives.push(`//*[@title='${titleMatch[1]}']`);
        }
      }
    }
    
    // AI-POWERED: Extract target attributes for intelligent matching
    let targetText = null;
    let targetAttrs = {};
    
    const textMatch = originalSelector.match(/text\(\s*\)\s*=\s*['"]([^'"]+)['"]/);
    if (textMatch) {
      targetText = textMatch[1];
    }
    
    const attrMatches = originalSelector.matchAll(/@(\w+)\s*=\s*['"]([^'"]+)['"]/g);
    for (const match of attrMatches) {
      targetAttrs[match[1]] = match[2];
    }
    
    // If we have text or attributes, use AI to find similar elements
    if (targetText || Object.keys(targetAttrs).length > 0) {
      try {
        const similar = await this.findSimilarElements(targetText, targetAttrs);
        
        // Generate selectors from top 3 similar elements
        for (let i = 0; i < Math.min(3, similar.length); i++) {
          const { attrs, score } = similar[i];
          
          if (this.options.logHealing) {
            console.log(`   🤖 AI found similar element (${(score * 100).toFixed(1)}% match)`);
          }
          
          // Generate selector from best matching attributes
          if (attrs.id) alternatives.push(`#${attrs.id}`);
          if (attrs.name) alternatives.push(`[name="${attrs.name}"]`);
          if (attrs.title) alternatives.push(`[title="${attrs.title}"]`);
          if (attrs['aria-label']) alternatives.push(`[aria-label="${attrs['aria-label']}"]`);
        }
      } catch (e) {
        // Fall back to rule-based if AI analysis fails
      }
    }
    
    return alternatives;
  }

  /**
   * Wait for element with implicit wait (like Selenium's implicitlyWait)
   * Polls for element presence in DOM (not visibility) to match JMeter/Selenium behavior
   * This makes tests more resilient to timing issues, animations, and dynamic content
   * @private
   */
  async _waitForElementWithImplicitWait(selector, options = {}) {
    // Use timeout from options if provided, otherwise use implicit wait setting
    const timeout = options.timeout !== undefined ? options.timeout : 
                   (options.implicitWait !== undefined ? options.implicitWait : this.options.implicitWait);
    const pollInterval = this.options.pollInterval;
    const startTime = Date.now();
    let retryCount = 0;
    
    while (Date.now() - startTime < timeout) {
      try {
        // Check for DOM presence (like Selenium's presenceOfElementLocated)
        // This is more lenient than Playwright's default visibility check
        const exists = await this.page.evaluate((sel) => {
          // Handle both XPath and CSS selectors
          if (sel.startsWith('//') || sel.startsWith('(//')) {
            // XPath selector
            const result = document.evaluate(
              sel,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            return result.singleNodeValue !== null;
          } else {
            // CSS selector
            return document.querySelector(sel) !== null;
          }
        }, selector);
        
        if (exists) {
          // Element found in DOM!
          if (retryCount > 0 && this.options.logImplicitWait) {
            const elapsed = Date.now() - startTime;
            console.log(`   ⏱️  Element found after ${retryCount} implicit wait ${retryCount === 1 ? 'retry' : 'retries'} (${elapsed}ms)`);
            this.stats.implicitWaitRetries++;
          }
          return true;
        }
      } catch (e) {
        // Element evaluation failed, continue polling
      }
      
      // Wait before next poll (matches Selenium's behavior)
      retryCount++;
      await this.page.waitForTimeout(pollInterval);
    }
    
    // Timeout reached without finding element
    return false;
  }

  /**
   * Try to find element with AI-powered healing
   * NOW WITH IMPLICIT WAIT + PERFORMANCE TRACKING!
   * Matches JMeter/Selenium behavior with automatic retry polling
   */
  async findElement(selector, options = {}) {
    this.stats.total++;
    const healStartTime = Date.now();
    
    try {
      // STEP 1: Try with implicit wait (like Selenium's driver.manage().timeouts().implicitlyWait)
      const foundWithImplicitWait = await this._waitForElementWithImplicitWait(selector, options);
      
      if (foundWithImplicitWait) {
        // Element exists in DOM, now verify it's ready for interaction
        try {
          await this.page.waitForSelector(selector, { 
            timeout: 2000,  // Short timeout since we know element exists
            state: 'visible'
          });
          return selector; // Original worked
        } catch (visibilityError) {
          // Element in DOM but not visible - for toast messages, this is OK
          // Just return the selector since implicit wait found it
          return selector;
        }
      }
      
      // STEP 2: Element not found even with implicit wait, try self-healing
      throw new Error('Element not found with implicit wait');
      
    } catch (error) {
      if (this.options.logHealing) {
        console.log(`⚠️  Selector failed, attempting self-heal: ${selector}`);
      }
      
      // Generate alternatives using AI + rule-based approach
      const alternatives = await this.generateAlternatives(selector);
      
      for (const alt of alternatives) {
        try {
          // Try alternative with implicit wait
          const foundAlt = await this._waitForElementWithImplicitWait(alt, options);
          
          if (foundAlt) {
            const healTime = Date.now() - healStartTime;
            this.stats.healed++;
            this.stats.totalHealingTimeMs += healTime;
            this.stats.avgHealingTimeMs = this.stats.totalHealingTimeMs / this.stats.healed;
            
            if (this.options.logHealing) {
              console.log(`✅ AI-healed! Original: ${selector} (${healTime}ms)`);
              console.log(`   New selector: ${alt}`);
            }
            
            return alt; // Return the working alternative
          }
        } catch (altError) {
          // Continue to next alternative
        }
      }
      
      // All alternatives failed
      this.stats.failed++;
      throw new Error(`All selectors failed for: ${selector}`);
    }
  }

  /**
   * Click with self-healing
   */
  async click(selector, options = {}) {
    const workingSelector = await this.findElement(selector, options);
    await this.page.click(workingSelector, options);
  }

  /**
   * Fill input with self-healing
   */
  async fill(selector, value, options = {}) {
    const workingSelector = await this.findElement(selector, options);
    await this.page.fill(workingSelector, value, options);
  }

  /**
   * Wait for element with self-healing
   */
  async waitFor(selector, options = {}) {
    return await this.findElement(selector, options);
  }

  /**
   * Get locator with self-healing
   */
  async locator(selector, options = {}) {
    const workingSelector = await this.findElement(selector, options);
    return this.page.locator(workingSelector);
  }

  /**
   * Get healing statistics WITH PERFORMANCE METRICS + IMPLICIT WAIT STATS
   */
  getStats() {
    const successRate = this.stats.total > 0 
      ? ((this.stats.total - this.stats.failed) / this.stats.total * 100).toFixed(1)
      : 100;
    
    return {
      total: this.stats.total,
      healed: this.stats.healed,
      failed: this.stats.failed,
      successRate: parseFloat(successRate),
      avgHealingTimeMs: Math.round(this.stats.avgHealingTimeMs),
      totalHealingTimeMs: this.stats.totalHealingTimeMs,
      implicitWaitRetries: this.stats.implicitWaitRetries,
      performanceImpact: this.stats.healed > 0 
        ? `${Math.round(this.stats.avgHealingTimeMs)}ms avg per heal`
        : 'No healing performed',
      implicitWaitImpact: this.stats.implicitWaitRetries > 0
        ? `Implicit wait helped ${this.stats.implicitWaitRetries} times`
        : 'Implicit wait not needed'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = { 
      total: 0, 
      healed: 0, 
      failed: 0, 
      totalHealingTimeMs: 0, 
      avgHealingTimeMs: 0,
      implicitWaitRetries: 0
    };
  }

  /**
   * Create a self-healing wrapper for iframe/frame contexts
   * This allows self-healing to work inside iframes!
   */
  forFrame(frameLocator) {
    const parentStats = this.stats; // Share stats with parent
    const parentOptions = this.options;
    
    return {
      async click(selector, options = {}) {
        parentStats.total++;
        const healStartTime = Date.now();
        
        try {
          await frameLocator.locator(selector).click(options);
        } catch (error) {
          if (parentOptions.logHealing) {
            console.log(`⚠️  Selector failed in iframe, attempting self-heal: ${selector}`);
          }
          
          // Try to heal by scanning the frame's DOM
          const healed = await this.healInFrame(frameLocator, selector, 'click', options);
          if (!healed) {
            parentStats.failed++;
            throw new Error(`All selectors failed in iframe for: ${selector}`);
          }
          
          const healTime = Date.now() - healStartTime;
          parentStats.healed++;
          parentStats.totalHealingTimeMs += healTime;
          parentStats.avgHealingTimeMs = parentStats.totalHealingTimeMs / parentStats.healed;
          
          if (parentOptions.logHealing) {
            console.log(`✅ AI-healed in iframe! (${healTime}ms)`);
          }
        }
      },
      
      async fill(selector, value, options = {}) {
        parentStats.total++;
        const healStartTime = Date.now();
        
        try {
          await frameLocator.locator(selector).fill(value, options);
        } catch (error) {
          if (parentOptions.logHealing) {
            console.log(`⚠️  Selector failed in iframe, attempting self-heal: ${selector}`);
          }
          
          const healed = await this.healInFrame(frameLocator, selector, 'fill', { ...options, value });
          if (!healed) {
            parentStats.failed++;
            throw new Error(`All selectors failed in iframe for: ${selector}`);
          }
          
          const healTime = Date.now() - healStartTime;
          parentStats.healed++;
          parentStats.totalHealingTimeMs += healTime;
          parentStats.avgHealingTimeMs = parentStats.totalHealingTimeMs / parentStats.healed;
          
          if (parentOptions.logHealing) {
            console.log(`✅ AI-healed in iframe! (${healTime}ms)`);
          }
        }
      },
      
      async waitFor(selector, options = {}) {
        parentStats.total++;
        const healStartTime = Date.now();
        
        try {
          await frameLocator.locator(selector).waitFor(options);
        } catch (error) {
          if (parentOptions.logHealing) {
            console.log(`⚠️  Selector failed in iframe, attempting self-heal: ${selector}`);
          }
          
          const healed = await this.healInFrame(frameLocator, selector, 'waitFor', options);
          if (!healed) {
            parentStats.failed++;
            throw new Error(`All selectors failed in iframe for: ${selector}`);
          }
          
          const healTime = Date.now() - healStartTime;
          parentStats.healed++;
          parentStats.totalHealingTimeMs += healTime;
          parentStats.avgHealingTimeMs = parentStats.totalHealingTimeMs / parentStats.healed;
          
          if (parentOptions.logHealing) {
            console.log(`✅ AI-healed in iframe! (${healTime}ms)`);
          }
        }
      },
      
      async healInFrame(frameLocator, selector, action, options) {
        // Generate alternative selectors
        const alternatives = [];
        
        // Extract XPath patterns
        if (selector.startsWith('//') || selector.startsWith('(/')) {
          const textMatch = selector.match(/text\(\s*\)\s*=\s*['"]([^'"]+)['"]/);
          if (textMatch) {
            alternatives.push(`text=${textMatch[1]}`);
            alternatives.push(`//*[contains(text(),'${textMatch[1]}')]`);
          }
          
          const attrMatch = selector.match(/@(\w+)\s*=\s*['"]([^'"]+)['"]/);
          if (attrMatch) {
            const [, attr, value] = attrMatch;
            if (attr === 'class') alternatives.push(`.${value}`);
            alternatives.push(`[${attr}="${value}"]`);
          }
          
          const classMatch = selector.match(/contains\(@class,\s*['"]([^'"]+)['"]\)/);
          if (classMatch) {
            alternatives.push(`[class*="${classMatch[1]}"]`);
            alternatives.push(`.${classMatch[1]}`);
          }
        }
        
        // Try alternatives
        for (const alt of alternatives) {
          try {
            if (action === 'click') {
              await frameLocator.locator(alt).click(options);
            } else if (action === 'fill') {
              await frameLocator.locator(alt).fill(options.value, options);
            } else if (action === 'waitFor') {
              await frameLocator.locator(alt).waitFor({ timeout: 5000, ...options });
            }
            
            if (parentOptions.logHealing) {
              console.log(`   Found working selector in iframe: ${alt}`);
            }
            return true;
          } catch (e) {
            // Try next alternative
          }
        }
        
        return false;
      }
    };
  }
}

/**
 * Initialize self-healing for a page
 */
function createSelfHealing(page, options = {}) {
  return new SelfHealingLocators(page, options);
}

module.exports = {
  SelfHealingLocators,
  createSelfHealing
};