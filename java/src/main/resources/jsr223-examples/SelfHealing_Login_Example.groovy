/**
 * JSR223 Sampler Example: Login with Self-Healing
 * 
 * This script demonstrates how to use AI-powered self-healing
 * in JMeter JSR223 samplers for UI performance testing
 * 
 * Prerequisites:
 * - Healenium backend running (docker-compose up)
 * - SelfHealingHelper.groovy in classpath
 */

import com.testframework.utils.SelfHealingHelper

// Initialize self-healing driver
def healer = new SelfHealingHelper([
    healeniumUrl: vars.get("HEALENIUM_URL") ?: "http://localhost:7878",
    headless: true
])

try {
    // Navigate to application
    healer.get("https://your-app.com/login")
    
    // Fill login form with self-healing
    healer.fill("//input[@name='username']", "testuser@example.com")
    healer.fill("//input[@name='password']", "password123")
    
    // Click login button
    healer.click("//button[@type='submit']")
    
    // Wait for dashboard to load
    healer.waitFor("//div[@id='dashboard']", 30)
    
    // Verify login success
    def currentUrl = healer.getCurrentUrl()
    if (currentUrl.contains("dashboard")) {
        SampleResult.setSuccessful(true)
        SampleResult.setResponseMessage("Login successful with self-healing")
    } else {
        SampleResult.setSuccessful(false)
        SampleResult.setResponseMessage("Login failed - unexpected URL: ${currentUrl}")
    }
    
    // Get healing statistics
    def stats = healer.getStats()
    log.info("🔧 Healing Stats - Total: ${stats.total}, Healed: ${stats.healed}, Failed: ${stats.failed}")
    log.info("⏱️  Performance Impact: ${stats.performanceImpact}")
    
    // Store stats in JMeter variables for reporting
    vars.put("HEAL_TOTAL", stats.total.toString())
    vars.put("HEAL_HEALED", stats.healed.toString())
    vars.put("HEAL_SUCCESS_RATE", stats.successRate.toString())
    vars.put("HEAL_AVG_TIME_MS", stats.avgHealingTimeMs.toString())
    
} catch (Exception e) {
    SampleResult.setSuccessful(false)
    SampleResult.setResponseMessage("Error: ${e.message}")
    log.error("Test failed", e)
} finally {
    // Clean up
    healer.quit()
}