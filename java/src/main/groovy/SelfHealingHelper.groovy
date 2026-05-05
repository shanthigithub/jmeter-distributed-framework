package com.testframework.utils

import com.epam.healenium.SelfHealingDriver
import org.openqa.selenium.By
import org.openqa.selenium.WebDriver
import org.openqa.selenium.WebElement
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions
import org.openqa.selenium.support.ui.WebDriverWait
import org.openqa.selenium.support.ui.ExpectedConditions
import java.time.Duration

/**
 * AI-Powered Self-Healing Helper for JMeter JSR223 Samplers
 * Uses Healenium ML backend for intelligent element recovery
 * 
 * Usage in JSR223 Sampler:
 *   def healer = new SelfHealingHelper()
 *   healer.click("//button[@id='submit']")
 *   def stats = healer.getStats()
 */
class SelfHealingHelper {
    private WebDriver driver
    private SelfHealingDriver selfHealingDriver
    private Map<String, Object> stats
    private long totalHealingTimeMs = 0
    private String healeniumUrl
    
    /**
     * Initialize with options
     * @param options Map with: healeniumUrl (optional), headless (default: true)
     */
    SelfHealingHelper(Map options = [:]) {
        this.healeniumUrl = options.healeniumUrl ?: System.getenv("HEALENIUM_URL") ?: "http://localhost:7878"
        boolean headless = options.headless != null ? options.headless : true
        
        // Configure Chrome
        ChromeOptions chromeOptions = new ChromeOptions()
        if (headless) {
            chromeOptions.addArguments("--headless=new")
        }
        chromeOptions.addArguments(
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--window-size=1920,1080"
        )
        
        // Create self-healing driver
        WebDriver delegate = new ChromeDriver(chromeOptions)
        this.selfHealingDriver = SelfHealingDriver.create(delegate)
        this.driver = this.selfHealingDriver
        
        // Initialize stats
        resetStats()
        
        println("✅ Self-Healing WebDriver initialized (Healenium: ${healeniumUrl})")
    }
    
    /**
     * Navigate to URL
     */
    void get(String url) {
        driver.get(url)
    }
    
    /**
     * Click element with self-healing
     * @param locator XPath or CSS selector
     */
    void click(String locator) {
        long startTime = System.currentTimeMillis()
        stats.total++
        
        try {
            By by = parseLocator(locator)
            WebElement element = driver.findElement(by)
            element.click()
            
            long healTime = System.currentTimeMillis() - startTime
            if (healTime > 500) { // Likely healed if took >500ms
                stats.healed++
                totalHealingTimeMs += healTime
                println("⚡ Potential healing detected for: ${locator} (${healTime}ms)")
            }
        } catch (Exception e) {
            stats.failed++
            println("❌ Click failed: ${locator} - ${e.message}")
            throw e
        }
    }
    
    /**
     * Fill input with self-healing
     * @param locator XPath or CSS selector
     * @param text Text to type
     */
    void fill(String locator, String text) {
        long startTime = System.currentTimeMillis()
        stats.total++
        
        try {
            By by = parseLocator(locator)
            WebElement element = driver.findElement(by)
            element.clear()
            element.sendKeys(text)
            
            long healTime = System.currentTimeMillis() - startTime
            if (healTime > 500) {
                stats.healed++
                totalHealingTimeMs += healTime
                println("⚡ Potential healing detected for: ${locator} (${healTime}ms)")
            }
        } catch (Exception e) {
            stats.failed++
            println("❌ Fill failed: ${locator} - ${e.message}")
            throw e
        }
    }
    
    /**
     * Wait for element with self-healing
     * @param locator XPath or CSS selector
     * @param timeoutSeconds Timeout in seconds (default: 30)
     */
    void waitFor(String locator, int timeoutSeconds = 30) {
        long startTime = System.currentTimeMillis()
        stats.total++
        
        try {
            By by = parseLocator(locator)
            WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(timeoutSeconds))
            wait.until(ExpectedConditions.presenceOfElementLocated(by))
            
            long healTime = System.currentTimeMillis() - startTime
            if (healTime > 500) {
                stats.healed++
                totalHealingTimeMs += healTime
                println("⚡ Potential healing detected for: ${locator} (${healTime}ms)")
            }
        } catch (Exception e) {
            stats.failed++
            println("❌ Wait failed: ${locator} - ${e.message}")
            throw e
        }
    }
    
    /**
     * Find element with self-healing
     * @param locator XPath or CSS selector
     * @return WebElement
     */
    WebElement findElement(String locator) {
        stats.total++
        try {
            By by = parseLocator(locator)
            return driver.findElement(by)
        } catch (Exception e) {
            stats.failed++
            throw e
        }
    }
    
    /**
     * Execute JavaScript
     */
    Object executeScript(String script, Object... args) {
        return ((org.openqa.selenium.JavascriptExecutor) driver).executeScript(script, args)
    }
    
    /**
     * Get current URL
     */
    String getCurrentUrl() {
        return driver.getCurrentUrl()
    }
    
    /**
     * Take screenshot
     * @return Base64 encoded screenshot
     */
    String takeScreenshot() {
        return ((org.openqa.selenium.TakesScreenshot) driver).getScreenshotAs(org.openqa.selenium.OutputType.BASE64)
    }
    
    /**
     * Get healing statistics with performance metrics
     */
    Map<String, Object> getStats() {
        double avgHealingTime = stats.healed > 0 ? totalHealingTimeMs / stats.healed : 0
        double successRate = stats.total > 0 ? ((stats.total - stats.failed) / stats.total * 100) : 100
        
        return [
            total: stats.total,
            healed: stats.healed,
            failed: stats.failed,
            successRate: Math.round(successRate * 10) / 10,
            avgHealingTimeMs: Math.round(avgHealingTime),
            totalHealingTimeMs: totalHealingTimeMs,
            performanceImpact: stats.healed > 0 
                ? "${Math.round(avgHealingTime)}ms avg per heal"
                : "No healing detected"
        ]
    }
    
    /**
     * Reset statistics
     */
    void resetStats() {
        stats = [
            total: 0,
            healed: 0,
            failed: 0
        ]
        totalHealingTimeMs = 0
    }
    
    /**
     * Print statistics
     */
    void printStats() {
        def s = getStats()
        println("🔧 Self-Healing Stats:")
        println("   Total: ${s.total}, Healed: ${s.healed}, Failed: ${s.failed}")
        println("   Success Rate: ${s.successRate}%")
        println("   ⏱️  Performance: ${s.performanceImpact} | Total: ${s.totalHealingTimeMs}ms")
    }
    
    /**
     * Close browser
     */
    void quit() {
        if (driver != null) {
            printStats()
            driver.quit()
        }
    }
    
    /**
     * Parse locator string to By object
     */
    private By parseLocator(String locator) {
        if (locator.startsWith("//") || locator.startsWith("(//")) {
            return By.xpath(locator)
        } else if (locator.startsWith("id=")) {
            return By.id(locator.substring(3))
        } else if (locator.startsWith("name=")) {
            return By.name(locator.substring(5))
        } else if (locator.startsWith("css=")) {
            return By.cssSelector(locator.substring(4))
        } else if (locator.startsWith("#")) {
            return By.cssSelector(locator)
        } else if (locator.startsWith(".")) {
            return By.cssSelector(locator)
        } else {
            // Default to CSS selector
            return By.cssSelector(locator)
        }
    }
}