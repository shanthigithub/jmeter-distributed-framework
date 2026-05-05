/**
 * JSR223 Sampler Example: Iframe Interactions with Self-Healing
 * 
 * This example demonstrates how to work with iframes using
 * Healenium's AI-powered self-healing in JMeter
 * 
 * Use Cases:
 * - Dashboard widgets in iframes
 * - Embedded forms
 * - Third-party integrations (payment gateways, chat widgets)
 * - Legacy applications with frame-based layouts
 */

import com.testframework.utils.SelfHealingHelper

def healer = new SelfHealingHelper([
    healeniumUrl: "http://healenium-backend:7878",
    headless: true
])

try {
    // STEP 1: Navigate to page with iframes
    healer.get("https://your-app.com/dashboard")
    
    // STEP 2: Interact with main page (before iframe)
    healer.click("//button[@id='login']")
    healer.fill("//input[@name='username']", "testuser")
    healer.click("//button[@type='submit']")
    healer.waitFor("//div[@class='dashboard']", 30)
    
    // STEP 3: Switch to iframe and interact with elements inside
    def iframe = healer.switchToFrame("//iframe[@title='dashboard-widget']")
    
    // All iframe interactions use self-healing!
    iframe.waitFor("//div[@class='widget-container']", 20)
    iframe.click("//button[@id='refresh-data']")
    iframe.fill("//input[@name='filter']", "active")
    iframe.click("//button[text()='Apply']")
    
    log.info("✅ Iframe interactions completed")
    
    // STEP 4: Exit iframe and return to main page
    healer = iframe.exitFrame()
    
    // STEP 5: Continue with main page interactions
    healer.click("//a[@href='/reports']")
    healer.waitFor("//div[@id='reports-table']", 20)
    
    // STEP 6: Work with nested iframes (iframe within iframe)
    def outerIframe = healer.switchToFrame("//iframe[@id='outer']")
    outerIframe.waitFor("//iframe[@id='inner']", 10)
    
    def innerIframe = outerIframe.switchToFrame("//iframe[@id='inner']")
    innerIframe.click("//button[@id='submit']")
    
    // Exit nested iframes
    healer = innerIframe.exitFrame() // Back to main page
    
    // STEP 7: Multiple iframe interactions in sequence
    def widget1 = healer.switchToFrame(0) // By index
    widget1.click("//button[@id='action1']")
    healer = widget1.exitFrame()
    
    def widget2 = healer.switchToFrame(1) // Second iframe
    widget2.fill("//input[@name='value']", "test")
    healer = widget2.exitFrame()
    
    // Get comprehensive statistics (includes all iframe interactions!)
    def stats = healer.getStats()
    
    log.info("=" * 60)
    log.info("IFRAME TEST SUMMARY:")
    log.info("  Total Elements: ${stats.total}")
    log.info("  Elements Healed: ${stats.healed}")
    log.info("  Failed: ${stats.failed}")
    log.info("  Success Rate: ${stats.successRate}%")
    log.info("  Healing Performance: ${stats.performanceImpact}")
    log.info("=" * 60)
    
    // Store stats for JMeter reporting
    vars.put("IFRAME_HEAL_TOTAL", stats.total.toString())
    vars.put("IFRAME_HEAL_HEALED", stats.healed.toString())
    vars.put("IFRAME_HEAL_SUCCESS", stats.successRate.toString())
    
    SampleResult.setSuccessful(true)
    SampleResult.setResponseMessage("""
        Iframe test completed successfully
        Total interactions: ${stats.total}
        Healed: ${stats.healed}
        Performance: ${stats.performanceImpact}
    """.trim())
    
} catch (Exception e) {
    SampleResult.setSuccessful(false)
    SampleResult.setResponseMessage("Iframe test failed: ${e.message}")
    log.error("Test execution failed", e)
    
    // Try to switch back to main content in case of error
    try {
        healer.switchToDefaultContent()
    } catch (Exception ignored) {
        // Already in main context or driver closed
    }
    
} finally {
    healer.quit()
}

/*
 * BEST PRACTICES FOR IFRAME SELF-HEALING:
 * 
 * 1. Always exit frames when done:
 *    healer = iframe.exitFrame()
 * 
 * 2. Handle nested iframes carefully:
 *    outer = healer.switchToFrame("//iframe[@id='outer']")
 *    inner = outer.switchToFrame("//iframe[@id='inner']")
 *    healer = inner.exitFrame() // Back to main
 * 
 * 3. Statistics are shared across all contexts:
 *    Main page + all iframes share the same healing stats
 * 
 * 4. Switch by different methods:
 *    switchToFrame(0)                    // By index
 *    switchToFrame("//iframe[@id='x']")  // By XPath
 *    switchToFrame("#my-iframe")         // By CSS
 *    switchToFrame(frameElement)         // By WebElement
 * 
 * 5. Error handling:
 *    Always wrap iframe code in try-finally
 *    Call switchToDefaultContent() in catch block
 */