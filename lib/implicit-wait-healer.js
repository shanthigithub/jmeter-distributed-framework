/**
 * IMPLICIT WAIT WRAPPER FOR HEALWRIGHT
 * 
 * This wrapper adds Selenium-style implicit wait behavior to all Healwright operations.
 * Replicates JMeter/Selenium's: driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10))
 * 
 * Why This Is Needed:
 * - Selenium automatically polls for elements every 500ms for up to 10 seconds
 * - Playwright has no implicit wait - each operation is a single attempt with timeout
 * - This wrapper bridges the gap by adding automatic polling to ALL operations
 * 
 * Usage:
 *   const healer = await createHealer(page, config);
 *   const implicitHealer = new ImplicitWaitHealer(healer, { implicitWaitMs: 10000 });
 *   await implicitHealer.click("//button"); // Now polls automatically like Selenium!
 */

class ImplicitWaitHealer {
  /**
   * @param {Object} healer - The healwright healer instance
   * @param {Object} page - The Playwright page instance
   * @param {Object} options - Configuration options
   * @param {number} options.implicitWaitMs - Total time to wait (default: 10000ms)
   * @param {number} options.pollIntervalMs - Time between retries (default: 500ms)
   * @param {boolean} options.logPolling - Whether to log polling attempts (default: false)
   */
  constructor(healer, page, options = {}) {
    this.healer = healer;
    this.page = page;
    this.implicitWaitMs = options.implicitWaitMs || 10000; // Match JMeter default
    this.pollIntervalMs = options.pollIntervalMs || 500;    // Match Selenium default
    this.logPolling = options.logPolling || false;
  }

  /**
   * Core polling logic - waits for element to exist in DOM
   * @private
   */
  async _waitForElement(selector, operationName = 'operation') {
    const maxRetries = Math.ceil(this.implicitWaitMs / this.pollIntervalMs);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const locator = this.healer.locator(selector);
        const count = await locator.count();
        
        if (count > 0) {
          if (this.logPolling && attempt > 1) {
            console.log(`✅ [ImplicitWait] ${operationName} - Element found on attempt ${attempt} (${attempt * this.pollIntervalMs}ms)`);
          }
          return true;
        }
      } catch (e) {
        // Element not found, continue polling
      }
      
      if (attempt < maxRetries) {
        await this.page.waitForTimeout(this.pollIntervalMs);
      }
    }
    
    throw new Error(
      `[ImplicitWait] Element not found after ${this.implicitWaitMs}ms (${maxRetries} attempts): ${selector}`
    );
  }

  /**
   * Click with implicit wait - polls until element exists, then clicks
   */
  async click(selector, options = {}) {
    await this._waitForElement(selector, 'click');
    return this.healer.click(selector, options);
  }

  /**
   * Fill with implicit wait - polls until element exists, then fills
   */
  async fill(selector, value, options = {}) {
    await this._waitForElement(selector, 'fill');
    return this.healer.fill(selector, value, options);
  }

  /**
   * WaitFor - pass through directly to healer with explicit timeout
   * Note: waitFor() already has its own timeout parameter, so we don't apply
   * implicit wait here. Implicit wait is for operations without timeouts (click, fill).
   * This matches JMeter's model where implicit wait is for element location,
   * not for explicit waits which have their own timeout.
   */
  async waitFor(selector, options = {}) {
    // Pass through directly - explicit waits should use their own timeout
    return this.healer.waitFor(selector, options);
  }

  /**
   * Locator access - returns healer's locator for advanced operations
   */
  locator(selector) {
    return this.healer.locator(selector);
  }

  /**
   * forFrame - Create implicit wait wrapper for iframe context
   */
  forFrame(frameLocator) {
    const frameHealer = this.healer.forFrame(frameLocator);
    return new ImplicitWaitHealer(frameHealer, this.page, {
      implicitWaitMs: this.implicitWaitMs,
      pollIntervalMs: this.pollIntervalMs,
      logPolling: this.logPolling
    });
  }

  /**
   * Get healing statistics from underlying healer
   */
  getStats() {
    return this.healer.getStats();
  }

  /**
   * Pass through any other methods to the underlying healer
   */
  async [Symbol.for('nodejs.util.inspect.custom')]() {
    return `ImplicitWaitHealer(implicitWait: ${this.implicitWaitMs}ms, pollInterval: ${this.pollIntervalMs}ms)`;
  }
}

/**
 * Helper function to create implicit wait healer from page and config
 */
async function createImplicitWaitHealer(page, config, healerInstance) {
  const implicitWaitMs = config.implicitWait || config.explicitWait || 10000;
  const pollIntervalMs = config.pollInterval || 500;
  const logPolling = config.logImplicitWait || false;

  return new ImplicitWaitHealer(healerInstance, page, {
    implicitWaitMs,
    pollIntervalMs,
    logPolling
  });
}

module.exports = {
  ImplicitWaitHealer,
  createImplicitWaitHealer
};