/**
 * JSR223 Sampler Example: Complete User Flow with Self-Healing
 * 
 * This example shows a complete e-commerce flow:
 * - Login
 * - Search for product
 * - Add to cart
 * - Checkout
 * 
 * All with AI-powered self-healing using Healenium ML backend
 */

import com.testframework.utils.SelfHealingHelper

// Initialize with custom options
def healer = new SelfHealingHelper([
    healeniumUrl: "http://healenium-backend:7878",
    headless: true
])

try {
    // STEP 1: Login
    def startTime = System.currentTimeMillis()
    healer.get("https://your-app.com")
    healer.fill("//input[@id='email']", vars.get("USERNAME"))
    healer.fill("//input[@id='password']", vars.get("PASSWORD"))
    healer.click("//button[text()='Sign In']")
    healer.waitFor("//div[@class='user-menu']", 30)
    def loginTime = System.currentTimeMillis() - startTime
    log.info("✅ Login completed in ${loginTime}ms")
    
    // STEP 2: Search for product
    startTime = System.currentTimeMillis()
    healer.fill("//input[@name='search']", "laptop")
    healer.click("//button[@type='submit']")
    healer.waitFor("//div[@class='search-results']", 20)
    def searchTime = System.currentTimeMillis() - startTime
    log.info("✅ Search completed in ${searchTime}ms")
    
    // STEP 3: Select first product
    startTime = System.currentTimeMillis()
    healer.click("(//div[@class='product-card'])[1]")
    healer.waitFor("//button[contains(text(),'Add to Cart')]", 20)
    def selectTime = System.currentTimeMillis() - startTime
    log.info("✅ Product selected in ${selectTime}ms")
    
    // STEP 4: Add to cart
    startTime = System.currentTimeMillis()
    healer.click("//button[contains(text(),'Add to Cart')]")
    healer.waitFor("//div[@class='cart-confirmation']", 10)
    def addToCartTime = System.currentTimeMillis() - startTime
    log.info("✅ Added to cart in ${addToCartTime}ms")
    
    // STEP 5: View cart
    startTime = System.currentTimeMillis()
    healer.click("//a[@href='/cart']")
    healer.waitFor("//div[@class='cart-items']", 15)
    def viewCartTime = System.currentTimeMillis() - startTime
    log.info("✅ Cart viewed in ${viewCartTime}ms")
    
    // STEP 6: Proceed to checkout
    startTime = System.currentTimeMillis()
    healer.click("//button[text()='Proceed to Checkout']")
    healer.waitFor("//form[@id='checkout-form']", 20)
    def checkoutTime = System.currentTimeMillis() - startTime
    log.info("✅ Checkout page loaded in ${checkoutTime}ms")
    
    // Get comprehensive statistics
    def stats = healer.getStats()
    
    // Calculate total time
    def totalTime = loginTime + searchTime + selectTime + addToCartTime + viewCartTime + checkoutTime
    
    // Store timing data for JMeter reporting
    vars.put("LOGIN_TIME", loginTime.toString())
    vars.put("SEARCH_TIME", searchTime.toString())
    vars.put("SELECT_TIME", selectTime.toString())
    vars.put("ADD_TO_CART_TIME", addToCartTime.toString())
    vars.put("VIEW_CART_TIME", viewCartTime.toString())
    vars.put("CHECKOUT_TIME", checkoutTime.toString())
    vars.put("TOTAL_FLOW_TIME", totalTime.toString())
    
    // Store healing stats
    vars.put("HEAL_TOTAL", stats.total.toString())
    vars.put("HEAL_HEALED", stats.healed.toString())
    vars.put("HEAL_FAILED", stats.failed.toString())
    vars.put("HEAL_SUCCESS_RATE", stats.successRate.toString())
    vars.put("HEAL_AVG_TIME", stats.avgHealingTimeMs.toString())
    vars.put("HEAL_TOTAL_TIME", stats.totalHealingTimeMs.toString())
    
    // Log summary
    log.info("=" * 60)
    log.info("TEST SUMMARY:")
    log.info("  Total Flow Time: ${totalTime}ms")
    log.info("  Steps Completed: 6")
    log.info("")
    log.info("SELF-HEALING STATS:")
    log.info("  Elements Interacted: ${stats.total}")
    log.info("  Elements Healed: ${stats.healed}")
    log.info("  Failed: ${stats.failed}")
    log.info("  Success Rate: ${stats.successRate}%")
    log.info("  Healing Overhead: ${stats.totalHealingTimeMs}ms (${((stats.totalHealingTimeMs / totalTime) * 100).round(2)}% of total)")
    log.info("  Avg Healing Time: ${stats.avgHealingTimeMs}ms")
    log.info("=" * 60)
    
    // Set sample result
    SampleResult.setSuccessful(true)
    SampleResult.setResponseMessage("""
        Complete flow executed successfully
        Total Time: ${totalTime}ms
        Healing Stats: ${stats.healed} healed, ${stats.failed} failed
        Performance Impact: ${stats.performanceImpact}
    """.trim())
    
    // Add custom sample data for reporting
    SampleResult.setBytes(totalTime as long)
    SampleResult.setLatency(stats.totalHealingTimeMs as long)
    
} catch (Exception e) {
    SampleResult.setSuccessful(false)
    SampleResult.setResponseMessage("Flow failed: ${e.message}")
    log.error("Test execution failed", e)
    
    // Log healing stats even on failure
    try {
        def stats = healer.getStats()
        log.error("Healing stats at failure: Total=${stats.total}, Healed=${stats.healed}, Failed=${stats.failed}")
    } catch (Exception statsError) {
        log.error("Could not retrieve healing stats")
    }
    
} finally {
    // Always clean up
    healer.quit()
}