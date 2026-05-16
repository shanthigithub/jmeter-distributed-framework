/**
 * HEALWRIGHT INTEGRATION: ML-Powered Self-Healing Playwright Test
 * This version uses ML backend with client-side fallback for self-healing locators
 * When locators fail, healwright automatically finds the correct element using:
 * - Primary: ML backend (learns patterns across all tests)
 * - Fallback: Client-side logic (if backend unavailable)
 * 
 * ACCURATE PERFORMANCE MEASUREMENT:
 * - Uses constantTimer (6000ms default) AFTER each step as think time (NOT measured)
 * - timedAction blocks ONLY measure actual transaction time (clicks, waits for elements)
 * - Form filling is OUTSIDE timedAction blocks (NOT measured)
 * - NO artificial waits inside timedAction blocks
 * - This provides TRUE application performance metrics
 */

const crypto = require('crypto');
const https = require('https');
const { runParallelTest, timedAction } = require('../lib/test-runner');
const { SmartAPIGeneratorWithJMeter } = require('../lib/smart-api-generator-with-jmeter');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

/**
 * Generate random string (similar to JMeter's __RandomString function)
 * @param {number} length - Length of the random string
 * @param {string} chars - Characters to use (default: lowercase letters)
 * @returns {string} Random string
 * 
 * JMeter equivalent: ${__RandomString(14,abcdefghijklmnopqrstuvwxyz,varName)}
 * JavaScript:        randomString(14, 'abcdefghijklmnopqrstuvwxyz')
 */
function randomString(length, chars = 'abcdefghijklmnopqrstuvwxyz') {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Fetch Salesforce credentials from AWS Secrets Manager
 * Secret name: k6-framework/salesforce-jwt
 * Keys: SF_CONSUMER_KEY, SF_USERNAME, SF_PRIVATE_KEY_PEM_B64
 */
async function getSalesforceCredentials() {
  const secretName = process.env.AWS_SECRET_NAME || 'k6-framework/salesforce-jwt';
  const region = process.env.AWS_REGION || 'us-east-1';
  
  const client = new SecretsManagerClient({ region });
  
  try {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    
    const secret = JSON.parse(response.SecretString);
    
    // Clean up private key (trim whitespace, it's already in PEM format)
    const privateKeyPem = secret.SF_PRIVATE_KEY_PEM_B64.trim();
    
    return {
      consumerKey: secret.SF_CONSUMER_KEY,
      username: secret.SF_USERNAME,
      privateKey: privateKeyPem
    };
  } catch (error) {
    console.error('❌ Failed to fetch credentials from AWS Secrets Manager:', error.message);
    throw new Error(`Unable to retrieve Salesforce credentials: ${error.message}`);
  }
}

const config = {
  parallelUsers: parseInt(process.env.PARALLEL_USERS || '1'),
  iterations: parseInt(process.env.ITERATIONS || '1'),
  rampUpTime: parseInt(process.env.RAMP_UP_TIME || '60'),
  constantTimer: parseInt(process.env.CONSTANT_TIMER || '6000'),  // Match JMeter ConstantTimer
  loginUrl: process.env.LOGIN_URL || 'https://test.salesforce.com',
  accountNumber: randomString(14, 'abcdefghijklmnopqrstuvwxyz'),  // Like JMeter: ${__RandomString(14,abcdefghijklmnopqrstuvwxyz,accountNumber)}
  firstName: randomString(14, 'abcdefghijklmnopqrstuvwxyz'),      // Like JMeter: ${__RandomString(14,abcdefghijklmnopqrstuvwxyz,firstName)}
  lastName: randomString(14, 'abcdefghijklmnopqrstuvwxyz'),      // Like JMeter: ${__RandomString(14,abcdefghijklmnopqrstuvwxyz,  lastName: randomString(14, 'abcdefghijklmnopqrstuvwxyz'),      // Like JMeter: ${__RandomString(14,abcdefghijklmnopqrstuvwxyz,firstName)})}
  oppName: randomString(14, 'abcdefghijklmnopqrstuvwxyz'),        // Like JMeter: ${__RandomString(14,abcdefghijklmnopqrstuvwxyz,oppName)}
  explicitWait: 120000,  // Match JMeter WebDriverWait (180 seconds - used for all waits)
  implicitWait: 10000,   // Match JMeter implicitlyWait (10 seconds - automatic polling for ALL operations)
  pollInterval: 500,     // Match Selenium's default poll interval
  logImplicitWait: true, // Log when polling finds elements after retries
  // ✨ AUTOMATIC BROWSER SETUP - Just one line!
  browserConfig: { healerMode: 'hybrid' }
};

// Credentials will be fetched from AWS Secrets Manager at runtime
let salesforceCredentials = null;

function generateJWT() {
  if (!salesforceCredentials) {
    throw new Error('Salesforce credentials not loaded. Call getSalesforceCredentials() first.');
  }
  
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { 
    iss: salesforceCredentials.consumerKey, 
    sub: salesforceCredentials.username, 
    aud: config.loginUrl, 
    exp: Math.floor(Date.now() / 1000) + 300 
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signatureInput = `${encodedHeader}.${encodedClaims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  sign.end();
  return `${signatureInput}.${sign.sign(salesforceCredentials.privateKey, 'base64url')}`;
}

async function getSalesforceAccessToken() {
  return new Promise((resolve, reject) => {
    const jwt = generateJWT();
    const postData = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString();
    const options = { hostname: new URL(config.loginUrl).hostname, path: '/services/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': postData.length }};
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(`OAuth failed: ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runUser(userId, iterationNumber, { page, healer }) {
  console.log(`👤 User ${userId}: Starting iteration ${iterationNumber} with Self-Healing`);
  
  // 🎯 API Generator Integration: Enable for first user only
  let apiGen;
  if (userId === 1 && iterationNumber === 1) {
    console.log('🎥 API Generator ENABLED - Will capture API calls and generate 3 test formats');
    apiGen = new SmartAPIGeneratorWithJMeter();
    await apiGen.captureFromBrowser(page);
  }
  
  try {
    // Step_001: OAuth Authentication
    apiGen?.startTransaction('Step_001_002_OAuth_Login');
    const authData = (await timedAction(userId, 'Step_001_OAuth', getSalesforceAccessToken)).result;
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_002: Enterprise Login
    await timedAction(userId, 'Step_002_Enterprise_Login', async () => {
      await page.goto(`${authData.instance_url}/secur/frontdoor.jsp?sid=${authData.access_token}`, { timeout: config.explicitWait });
      
      // Wait for dashboard to load - WITH IFRAME SELF-HEALING!
      const iframe = page.frameLocator("(//*[@title='dashboard'])");
      const iframeHealer = healer.forFrame(iframe);
      await iframeHealer.waitFor("//*[contains(@class,'widget-container')][1]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_003: Click Accounts
    await timedAction(userId, 'Step_003_Enterprise_Clickon_Accounts', async () => {
      await healer.click("//*[@title='Accounts']");
      await healer.waitFor("//*[@role='grid']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_004: Click New Account
    await timedAction(userId, 'Step_004_Enterprise_Click_Accounts_New', async () => {
      await healer.click("//a[@title='New']");
      await healer.waitFor("//*[@name='CancelEdit']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Fill Account Details (NOT measured - form filling time)
    await healer.fill("//label[text()='Account Name']/parent::div/div/input", config.accountNumber);
    await healer.click("//*[@name='country']");
    await healer.click("//*[@title='UNITED STATES']");
    await healer.fill("//*[@name='street']", "400 Pine St");
    await healer.fill("//*[@name='city']", "Abilene");
    await healer.click("//*[@name='province']");
    await healer.click("//*[@title='TEXAS']");
    await healer.fill("//*[@name='postalCode']", "79601-5108");
    await healer.fill("//*[@name='VAT_Number__c']", "796018");

    // Scroll and click
    const frozenEl = await healer.locator("//button[@aria-label='Frozen Market Current Year Segment L1']");
    await frozenEl.scrollIntoViewIfNeeded();
    await healer.click("//button[@aria-label='Frozen Market Current Year Segment L1']");
    await healer.click("//*[@title='Professional Tax']");

    const taxAcctEl = await healer.locator("//button[@aria-label='Tax & Accounting Firms']");
    await taxAcctEl.scrollIntoViewIfNeeded();
    await healer.click("//button[@aria-label='Tax & Accounting Firms']");
    await healer.click("//*[@title='Not on this list']");

    await healer.click("//button[@aria-label='Number Of Employees']");
    await healer.click("//*[@title='1-29']");
    
    // Step_005: Save Account (ONLY save click is measured)
    await timedAction(userId, 'Step_005_Enterprise_Enter_AccountDetails_Click_Save', async () => {
      await healer.click("//*[@name='SaveEdit']");

      // Wait for toast message to appear
      await healer.waitFor("//*[contains(@class,'toastMessage')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_006: Click Contacts
    await timedAction(userId, 'Step_006_Enterprise_Click_Contacts_QuickLink', async () => {
      await healer.click("//slot[contains(text(),'Contacts')]//ancestor::a");
      await healer.waitFor("//button[contains(text(),'New')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_007: Click New Contact
    await timedAction(userId, 'Step_007_Enterprise_Click_Contacts_New_Button', async () => {
      await healer.click("//button[contains(text(),'New')]");
      await healer.waitFor("//*[@name='CancelEdit']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Fill Contact Details (NOT measured - form filling time)
    await healer.fill("//*[@name='firstName']", config.firstName);
    await healer.fill("//*[@name='lastName']", config.lastName);
    await healer.fill("//*[@name='Email']", "rambabu.chitteti@thomsonreuters.com");
    await healer.click("(//*[@aria-label='Language Preference'])[1]");
    await healer.click("//*[@title='English']");
    
    // Step_008: Save Contact (ONLY save click is measured)
    await timedAction(userId, 'Step_008_Enterprise_Enter_ContactDetails_Click_Save', async () => {
      await healer.click("//*[@name='SaveEdit']");

      // Wait for toast message to appear
      await healer.waitFor("//*[contains(@class,'toastMessage')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_009: Click New Opportunity
    await timedAction(userId, 'Step_009_Enterprise_Click_NewOpportunity_Button', async () => {
      await healer.click("//*[@name='Contact.LTGS_New_Opportunity']");
      await healer.waitFor("//*[@name='CancelEdit']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Fill Opportunity Details (NOT measured - form filling time)
    await healer.fill("//*[@name='Name']", config.oppName);
    await healer.click("//button[@aria-label='Stage']");
    await healer.click("//*[@data-value='1 Lead Management']");
    await healer.fill("//*[@name='CloseDate']", "06/30/2026");
    await healer.click("//button[@aria-label='Brand']");
    await healer.click("//*[@data-value='Checkpoint']");
    
    const materialEl = await healer.locator("//*[@title='AUDIT & ACCOUNTING']");
    await materialEl.scrollIntoViewIfNeeded();
    await healer.click("//*[@title='AUDIT & ACCOUNTING']");
    await healer.click("//button[@title='Move selection to Chosen']");
    
    const sourceEl = await healer.locator("//button[@aria-label='Source']");
    await sourceEl.scrollIntoViewIfNeeded();
    await healer.click("//button[@aria-label='Source']");
    await healer.click("//*[@data-value='Call Center']");
    
    // Step_010: Save Opportunity (ONLY save click is measured)
    await timedAction(userId, 'Step_010_Enterprise_Enter_OpportunityDetails_Click_Save', async () => {
      await healer.click("//*[@name='SaveEdit']");
      await healer.waitFor("//*[@title='Create Quote/Proposal']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_011: Click Edit on Opportunity
    await page.waitForTimeout(5000);  // Wait 5 seconds before starting (matches JMeter)
    await timedAction(userId, 'Step_011_Enterprise_Opportunity_Click_Edit', async () => {
      await healer.click("(//*[@name='Edit'])[2]");
      await healer.waitFor("//*[@name='CancelEdit']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_012: Click Create SSD
    // Scroll to the SSD section BEFORE measurement
    const ssdSection = await healer.locator("(//*[@data-component-id='flexipage_fieldSection27'])");
    await ssdSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);  // Wait 2 seconds after scroll
    
    await timedAction(userId, 'Step_012_Enterprise_Click_Create_SSD', async () => {
      await healer.click("//*[@alt='Create SSD']");
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_013: Select SSD Details and Save (includes iframe handling)
    // Form filling BEFORE measurement (NOT counted in response time)
    const ssdIframe = page.frameLocator("//iframe[@title='accessibility title']");
    const ssdIframeHealer = healer.forFrame(ssdIframe);
    
    // Select dropdown option (form interaction)
    await ssdIframeHealer.click("//select[@id='mainPg:mainFrm:entryBlock:ssdSalesOrg']");
    await ssdIframeHealer.click("//option[@value='GLOBAL']");
    
    // Wait for form to stabilize and Save button to be ready
    await ssdIframeHealer.waitFor("(//*[@value='Save'])[1]", { timeout: config.explicitWait });
    
    // Scroll Save button into view
    const saveButton = await ssdIframeHealer.locator("(//*[@value='Save'])[1]");
    await saveButton.scrollIntoViewIfNeeded();
    
    // NOW measure ONLY the Save click + response validation
    await timedAction(userId, 'Step_013_Enterprise_Select_SSD_Details_Click_Save', async () => {
      await ssdIframeHealer.click("(//*[@value='Save'])[1]");
      await healer.waitFor("//*[@title='Create Quote/Proposal']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer1 in JMeter)
    
    // Step_014: Click Products QuickLink
    // Scroll to Products link BEFORE measurement
    const productsLink = await healer.locator("//*[contains(text(),'Products')]/parent::span/parent::a");
    await productsLink.scrollIntoViewIfNeeded();
    
    await timedAction(userId, 'Step_014_Enterprise_Click_Products_QuickLink', async () => {
      await healer.click("//*[contains(text(),'Products')]/parent::span/parent::a");
      await healer.waitFor("//a[@title='Choose Price Book']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_015: Choose Price Book and Save
    // Click Choose Price Book (NOT measured - form interaction)
    await healer.click("//a[@title='Choose Price Book']");
    await page.waitForTimeout(3000);  // Wait 3 seconds
    
    await timedAction(userId, 'Step_015_Enterprise_Click_ChoosePriceBook_Save', async () => {
      await healer.click("(//*[@type='button']/span[text()='Save'])[2]/parent::button");
      
      // Wait until the price book popup disappears
      await page.waitForFunction(
        () => !document.evaluate(
          "(//*[@type='button']/span[text()='Save'])[2]/parent::button",
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue,
        { timeout: config.explicitWait }
      );
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_016: Click Opportunity Link (Breadcrumb)
    await timedAction(userId, 'Step_016_Enterprise_Click_Opportunity_Link', async () => {
      await healer.click("//*[@aria-label='Breadcrumbs']/ol/li[2]/a");
      await healer.waitFor("//*[@title='Create Quote/Proposal']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(3000);  // 3 second sleep after (matches JMeter)
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_017: Click Create Quote/Proposal
    await timedAction(userId, 'Step_017_Enterprise_Click_CreateQuote_Proposal', async () => {
      await healer.click("//*[@title='Create Quote/Proposal']");
      await healer.waitFor("(//*[text()='Line Items'])[2]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_018: Edit Approval Segment
    // Page preparation BEFORE measurement
    await page.waitForTimeout(10000);  // Wait 10 seconds before starting
    await page.evaluate(() => window.scrollBy(0, 2090));  // Scroll to section
    await page.waitForTimeout(10000);  // Wait for scroll to complete
    
    // NOW measure ONLY the click + response validation
    await timedAction(userId, 'Step_018_Enterprise_ApprovalSegment_Edit', async () => {
      await healer.click("//*[@title='Edit Approval Segment']");
      await healer.waitFor("//*[@aria-label='Approval Segment']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_019: Save Approval Segment
    // Click Approval Segment dropdown and select option (NOT measured - form interaction)
    await healer.click("//*[@aria-label='Approval Segment']");
    await page.waitForTimeout(4000);  // Wait 4 seconds
    await healer.click("//*[@title='Tax Prof – Large Tax']");
    await page.waitForTimeout(4000);  // Wait 4 seconds
    
    await timedAction(userId, 'Step_019_Enterprise_ApprovalSegment_Save', async () => {
      await healer.click("//*[@name='SaveEdit']");
      
      // Wait until Save button disappears
      await page.waitForFunction(
        () => !document.evaluate(
          "//*[@name='SaveEdit']",
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue,
        { timeout: config.explicitWait }
      );
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_020: Click Add/Edit Products
    // ALL page preparation BEFORE measurement
    await page.waitForTimeout(5000);  // Wait 5 seconds before starting
    
    const actionsSection = await healer.locator("(//*[@data-component-id='flexipage_fieldSection'])");
    await actionsSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    
    await page.evaluate(() => window.scrollBy(0, 300));
    
    const addEditLink = await healer.locator("//a[contains(@href,'/apex/Apttus_QPConfig__ProposalConfiguration')]");
    await addEditLink.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);  // Wait 3 seconds
    
    // NOW measure ONLY the click
    await timedAction(userId, 'Step_020_Enterprise_Click_AddEdit_Products', async () => {
      await healer.click("//a[contains(@href,'/apex/Apttus_QPConfig__ProposalConfiguration')]");
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_021: Click SUREPREP Link (WITH IFRAME HANDLING)
    await page.waitForTimeout(25000);  // Wait 25 seconds before starting
    
    await timedAction(userId, 'Step_021_Enterprise_Click_SUREPREP_Link', async () => {
      // Switch to iframe with dynamic title (uses ToppName variable)
      const iframe = page.frameLocator("//iframe[@title]").first();  // Get first iframe with title attribute
      const iframeHealer = healer.forFrame(iframe);
      
      // Click on SUREPREP link
      await iframeHealer.click("/html[1]/body[1]/span[1]/div[3]/div[6]/div[1]/div[1]/div[2]/div[1]/div[1]/div[2]/div[2]/ul[1]/li[1]/a[1]");
      
      // Wait for product checkboxes to appear
      await iframeHealer.waitFor("//*[@class='listing-check checkbox-override']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer_max in JMeter)
    
    // Step_022: Select 20 Products and Add To Cart (COMPLEX PRODUCT SELECTION)
    // ALL product selection BEFORE measurement (form filling)
    const productIframe = page.frameLocator("//iframe[@title]").first();
    const productIframeHealer = healer.forFrame(productIframe);
    
    // Select up to 20 products (NOT measured - this is form interaction)
    let count = 0;
    for (let i = 1; i <= 20 && count < 20; i++) {
      try {
        const checkboxExists = await page.evaluate((index) => {
          const xpath = `(//span[contains(@class,'listing-check') and contains(@class,'checkbox-override')])[${index}]`;
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return result.singleNodeValue !== null;
        }, i);
        
        if (!checkboxExists) continue;
        
        const checkbox = await productIframeHealer.locator(`(//span[contains(@class,'listing-check') and contains(@class,'checkbox-override')])[${i}]`);
        await checkbox.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        
        const subscriptionFeeText = await page.evaluate((index) => {
          const xpath = `/html/body/span[1]/div[3]/div[6]/div/div/div[2]/div/div[2]/div[2]/div[${index}]/ul/li/catalog-product/div/div[2]/div[1]/div/span[1]/span`;
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return result.singleNodeValue ? result.singleNodeValue.textContent.trim() : '';
        }, i);
        
        if (subscriptionFeeText === 'Subscription Fee') {
          await productIframeHealer.click(`(//span[contains(@class,'listing-check') and contains(@class,'checkbox-override')])[${i}]`);
          count++;
          await page.waitForTimeout(700);
        }
      } catch (e) {
        console.log(`Skipping product ${i}: ${e.message}`);
      }
    }
    
    await page.waitForTimeout(5000);  // Wait for selections to stabilize
    
    // Scroll Add to Cart button into view
    const addToCartBtn = await productIframeHealer.locator("//*[@class='ands-btn ands-primary cartTheme md-button md-ink-ripple']");
    await addToCartBtn.scrollIntoViewIfNeeded();
    
    // NOW measure ONLY Add to Cart click + validation
    await timedAction(userId, 'Step_022_Enterprise_Select_20Product_AddToCart', async () => {
      await productIframeHealer.click("//*[@class='ands-btn ands-primary cartTheme md-button md-ink-ripple']");
      
      // Wait for app to process (measures actual app performance)
      await page.waitForFunction(
        () => {
          const xpath = "//*[@class='ands-btn ands-secondary GoToPricing active-true md-button']";
          const btn = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          return btn && btn.getAttribute('disabled') !== null;
        },
        { timeout: 40000 }
      );
      
      await productIframeHealer.waitFor("//*[@buttonid='id_task_left_gotopricing']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer1)
    
    // Step_023: Click Go To Pricing (WITH PROGRESS BAR MONITORING)
    await timedAction(userId, 'Step_023_Enterprise_Click_GoToPricing', async () => {
      const iframe = page.frameLocator("//iframe[@title]").first();
      const iframeHealer = healer.forFrame(iframe);
      
      // Click Go to Pricing button
      await iframeHealer.click("//button[contains(@class,'ands-btn') and contains(@class,'GoToPricing')]");
      
      // Monitor progress bar until it reaches 100% (max 180 seconds)
      await page.waitForFunction(
        () => {
          const progressBar = document.evaluate(
            "//*[@id='progress-bar']/div/div",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          
          if (!progressBar) return false;
          
          const style = progressBar.getAttribute('style');
          if (!style) return false;
          
          const widthMatch = style.match(/width\s*:\s*([0-9]+%)/);
          return widthMatch && widthMatch[1] === '100%';
        },
        { timeout: 180000 }
      );
      
      // Wait for Add More Products button
      await iframeHealer.waitFor("//*[@buttonid='id_task_left_addmoreproducts']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer1)
    
    // Step_024: Apply Discount and Reprice (NOT measured - form interactions)
    const iframe = page.frameLocator("//iframe[@title]").first();
    const iframeHealer = healer.forFrame(iframe);
    
    await iframeHealer.click("//*[@id='picklistSelectMaterialDesign']");
    await page.waitForTimeout(1000);
    await page.click("/html/body/div[2]/md-select-menu/md-content/md-option[2]/div[1]");
    await page.waitForTimeout(5000);
    await page.fill("/html/body/span/div[3]/div[6]/div/div/div/cart-grid/div[2]/div[1]/div/div[1]/div[2]/div[2]/div/div[1]/div/div/div[5]/div/dynamic-field/div/div/md-input-container/input", "21");
    
    // Step_024: Click Save & Return to Cart (MEASURED - with progress monitoring)
    await timedAction(userId, 'Step_024_Enterprise_Click_Reprice_PostDiscount21', async () => {
      // Click Save & Return to Cart button
      await page.click("/html/body/span/div[3]/div[2]/div/div/div[2]/div/display-actions/div/button[4]");
      
      // Monitor progress bar until 100% (max 180 seconds)
      await page.waitForFunction(
        () => {
          const progressBar = document.evaluate(
            "//*[@id='progress-bar']/div/div",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          
          if (!progressBar) return false;
          
          const style = progressBar.getAttribute('style');
          if (!style) return false;
          
          const widthMatch = style.match(/width\s*:\s*([0-9]+%)/);
          if (widthMatch && widthMatch[1] === '100%') return true;
          
          // Also check if Add More Products button is visible (alternative success condition)
          const addMoreBtn = document.evaluate(
            "//*[@buttonid='id_task_left_addmoreproducts']",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          return addMoreBtn && addMoreBtn.offsetParent !== null;
        },
        { timeout: 180000 }
      );
      
      // Final wait for Add More Products button
      await iframeHealer.waitFor("//*[@buttonid='id_task_left_addmoreproducts']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_025: Click Submit For Approval
    await timedAction(userId, 'Step_025_Enterprise_Click_SubmitForApproval_Button', async () => {
      // Click Submit for Approval button (still in product iframe)
      await iframeHealer.click("//*[@buttonid='id_task_left_submitforapproval']");
      
      // Switch back to default content and then to new iframe
      // Wait for Quote/Proposal iframe to appear
      const quoteIframe = page.frameLocator("(//iframe[starts-with(@title, 'Quote/Proposal')])[1]");
      const quoteHealer = healer.forFrame(quoteIframe);
      
      // Wait for Submit button in the approval iframe
      await quoteHealer.waitFor("//input[contains(@class, 'slds-button_brand') and @value='Submit']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_026: Click Submit Button (WITH IFRAME SWITCHING)
    await timedAction(userId, 'Step_026_Enterprise_Click_Submit_Button', async () => {
      // Still in Quote/Proposal iframe from step 25
      const quoteIframe = page.frameLocator("(//iframe[starts-with(@title, 'Quote/Proposal')])[1]");
      const quoteHealer = healer.forFrame(quoteIframe);
      
      // Click Submit button using JavaScript executor
      await quoteHealer.click("//*[@value='Submit']");
      
      // Switch to accessibility title iframe (5th iframe)
      const accessibilityIframe = page.frameLocator("(//iframe[starts-with(@title, 'accessibility title')])[5]");
      const accessibilityHealer = healer.forFrame(accessibilityIframe);
      
      // Wait for Cancel button to appear
      await accessibilityHealer.waitFor("//*[@value='Cancel']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_027: Enter Comments and Click Submit (NOT measured - form filling)
    const accessibilityIframe = page.frameLocator("(//iframe[starts-with(@title, 'accessibility title')])[5]");
    const accessibilityHealer = healer.forFrame(accessibilityIframe);
    
    await accessibilityHealer.fill("//*[@id='j_id0:idApprovalContextSubmitForm:j_id163:idProcessLevelComment:j_id170:idProcessCommentOptional']", "Please Approve");
    
    // Step_027: Click Submit (MEASURED)
    await timedAction(userId, 'Step_027_Enterprise_Enter_Comments_Click_Submit_Button', async () => {
      // Click Submit button
      await accessibilityHealer.click("//*[@value='Submit']");
      
      // Stay in same iframe (5th accessibility title iframe)
      // Wait for Return button to appear
      await accessibilityHealer.waitFor("//*[@value='Return']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_028: Click Return To Quote
    await timedAction(userId, 'Step_028_Enterprise_Click_Return_To_Quote', async () => {
      // Click Return button (still in iframe)
      await accessibilityHealer.click("//*[@value='Return']");
      
      // Switch back to default content (main page)
      // Wait for Approval Requests link in main page
      await healer.waitFor("//a[contains(@href,'related/Apttus_QPApprov__ApprovalRequests__r/view')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_029: Click Approval Requests
    await timedAction(userId, 'Step_029_Enterprise_Click_ApprovalRequests', async () => {
      // Click Approval Requests link (in main page, not iframe)
      await healer.click("//a[contains(@href,'related/Apttus_QPApprov__ApprovalRequests__r/view')]");
      
      // Wait for Assigned link to appear
      await healer.waitFor("//a[contains(text(), 'Assigned')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_030: Click Assigned One
    await timedAction(userId, 'Step_030_Enterprise_Click_AssignedOne', async () => {
      // Click Assigned link
      await healer.click("//a[contains(text(), 'Assigned')]");
      
      // Wait for Approve / Reject button to appear
      await healer.waitFor("//button[contains(text(), 'Approve / Reject')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_031: Click Approve/Reject Button (COMPLEX POPUP WINDOW HANDLING)
    // Initial click and popup handling (NOT measured)
    await healer.click("//button[contains(text(), 'Approve / Reject')]");
    await page.waitForTimeout(10000);  // Wait 10 seconds for popup
    
    // Get all pages/windows and close any popups
    const pages = page.context().pages();
    for (const popup of pages) {
      if (popup !== page) {
        console.log(`Closing popup window: ${await popup.title()}`);
        await popup.close();
      }
    }
    
    await page.waitForTimeout(5000);  // Wait 5 seconds
    
    // Step_031: Click Approve/Reject Button Again (MEASURED)
    // Pre-check outside
    await healer.waitFor("//button[contains(text(), 'Approve / Reject')]", { timeout: config.explicitWait });
    await page.waitForTimeout(5000);  // Wait 5 seconds
    
    const iframeExists = await page.evaluate(() => {
      const xpath = "//*[@title='accessibility title']";
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue !== null;
    });
    
    await timedAction(userId, 'Step_031_Enterprise_Click_Approve_or_Reject_Button', async () => {
      // Click button if needed
      if (!iframeExists) {
        await healer.click("//button[contains(text(), 'Approve / Reject')]");
      }
      
      // Wait for iframe - measures app response
      await healer.waitFor("//*[@title='accessibility title']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_032: Enter Comments and Click Approve
    // Switch to iframe and enter comments (NOT measured - form filling)
    const approvalIframe = page.frameLocator("(//*[@title='accessibility title'])[5]");
    const approvalHealer = healer.forFrame(approvalIframe);
    
    await page.waitForTimeout(2000);  // Wait 2 seconds
    await approvalHealer.fill("//textarea", "Approver comments");
    
    // Step_032: Click Approve (MEASURED)
    await timedAction(userId, 'Step_032_Enterprise_Click_EnterComments_Approve', async () => {
      // Click Approve button
      await approvalHealer.click("//input[@value='Approve']");
      
      // Switch back to default content
      // Wait for Product Configuration screen to load
      await healer.waitFor("//*[text()='Product Configuration']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_033: Click Back to Quote (WITH COMPLEX NAVIGATION)
    // Pre-steps (NOT measured - scrolling and navigation)
    await page.waitForTimeout(4000);  // Wait 4 seconds
    await page.evaluate(() => window.scrollBy(0, 2010));  // Scroll by 2010 pixels
    await page.waitForTimeout(5000);  // Wait 5 seconds
    
    // Click Quote ID link (NOT measured)
    await healer.click("//a[contains(@href,'Apttus_Proposal__Proposal__c')]");
    await page.waitForTimeout(5000);  // Wait 5 seconds
    
    // Refresh page to unfreeze
    await page.reload();
    await healer.waitFor("//*[@title='Actions']", { timeout: config.explicitWait });
    
    // Step_033: Scroll and Wait for Edit Win/Lost Reason (MEASURED)
    // Scroll BEFORE measurement
    const actionsTab33 = await healer.locator("//*[@title='Actions']");
    await actionsTab33.scrollIntoViewIfNeeded();
    
    await timedAction(userId, 'Step_033_Enterprise_Click_BacktoQuote', async () => {
      await healer.waitFor("//*[@title='Edit Win/Lost Reason']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_034: Click Password Holders
    await page.waitForTimeout(500);  // Wait 500ms
    
    await timedAction(userId, 'Step_034_Enterprise_Click_Password_Holder', async () => {
      await healer.click("//button[(text()='Password Holders')]");
      
      // Wait for page response - measures app processing time
      await page.waitForFunction(
        () => document.title.includes("Apttus_Proposal__Proposal__c | Salesforce"),
        { timeout: config.explicitWait }
      );
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer_Max)
    
    // Step_035: Password Holder Form Fill and Save (COMPLEX FORM WITH IFRAME)
    // Switch to iframe and fill form (NOT measured - all form interactions)
    const passwordIframe = page.frameLocator("(//iframe[starts-with(@title, 'accessibility title')])[5]");
    const passwordHealer = healer.forFrame(passwordIframe);
    
    // Select LineItem Product
    await passwordHealer.click("//select[@title='LineItem Products']");
    await passwordHealer.click("//option[text()='Professional Services 1040SCAN & TaxCaddy Group Implementation']");
    
    // Scroll by 300 pixels
    await page.evaluate(() => window.scrollBy(0, 300));
    
    // Wait for loading to complete
    await page.waitForFunction(
      () => {
        const loadingEl = document.getElementById('el_loading');
        return !loadingEl || loadingEl.style.display === 'none' || !loadingEl.offsetParent;
      },
      { timeout: 20000 }
    );
    
    // Click Add Row button
    const addRowBtn = await passwordHealer.locator("//input[@value='Add Row']");
    await addRowBtn.scrollIntoViewIfNeeded();
    await passwordHealer.click("//input[@value='Add Row']");
    
    // Fill contact details in data table
    const dataColumns = await passwordHealer.locator("//tr[contains(@class,'dataRow even')]//td");
    
    // First Name (3rd column)
    await passwordHealer.fill("(//tr[contains(@class,'dataRow even')]//td)[3]//input", "Firstname");
    
    // Last Name (4th column)
    await passwordHealer.fill("(//tr[contains(@class,'dataRow even')]//td)[4]//input", "Lastname");
    
    // Select Type = Admin and click Add
    await passwordHealer.click(".//select[@title='Type - Available']");
    await passwordHealer.click("//option[text()='Admin']");
    await passwordHealer.click(".//td[@class='multiSelectPicklistCell']//a[@title='Add']");
    
    // Email (8th column)
    await passwordHealer.fill("(//span//div//input[@type='text'])[3]", "ptuitestdata@gmail.com");
    
    // Click Save
    await passwordHealer.click("//div//input[@value='Save']");
    await page.waitForTimeout(1000);
    
    // Click Save to All Products and handle alert
    await passwordHealer.click("//div[@class='pbBottomButtons']//table//input[@value='Save to All Products']");
    await page.waitForTimeout(5000);
    
    // Accept alert
    page.on('dialog', async dialog => {
      await dialog.accept();
    });
    
    await page.waitForTimeout(3000);
    
    // Step_035: Click Cancel and Exit (MEASURED)
    // Scroll BEFORE measurement
    await page.evaluate(() => window.scrollBy(0, 300));
    
    await timedAction(userId, 'Step_035_Enterprise_Password_Holder_Click_Save', async () => {
      // Click Cancel button
      await passwordHealer.click("//div[@class='pbBottomButtons']//table//input[@value='Cancel']");
      
      // Switch back to default content (iframe exit handled automatically)
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer_Max)
    
    // Step_039: Click Win/Lost Reason Edit
    // Page refresh and scrolling BEFORE measurement
    await page.reload();
    
    const actionsTab39 = await healer.locator("//*[@title='Actions']");
    await actionsTab39.scrollIntoViewIfNeeded();
    
    await page.evaluate(() => window.scrollBy(0, -50));
    
    await timedAction(userId, 'Step_039_Enterprise_Click_WinLost_Reason_Edit', async () => {
      // Click Edit Win/Lost Reason
      await healer.click("//*[@title='Edit Win/Lost Reason']");
      
      // Wait for Win/Lost Reason dropdown to be clickable
      await healer.waitFor("//*[@aria-label='Win/Lost Reason']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_040: Select Auto Renewal and Save
    // Select dropdown option (NOT measured - form interaction)
    await healer.click("//*[@aria-label='Win/Lost Reason']");
    await healer.click("//*[@title='Auto Renewal']");
    
    // Step_040: Click Save (MEASURED)
    await timedAction(userId, 'Step_040_Enterprise_WinLost_Reason_Select_AutoRenewal_Save', async () => {
      // Click SaveEdit button
      await healer.click("//*[@name='SaveEdit']");
      
      // Wait until Edit Win/Lost Reason button is clickable again
      await healer.waitFor("//*[@title='Edit Win/Lost Reason']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_041: Click Signature Expiry Date Edit
    // Scroll BEFORE measurement
    const actionsTab41 = await healer.locator("//*[@title='Actions']");
    await actionsTab41.scrollIntoViewIfNeeded();
    
    await timedAction(userId, 'Step_041_Enterprise_SignatureExpiryDate_Edit', async () => {
      // Click Edit Signature Expiry Date
      await healer.click("//*[@title='Edit Signature Expiry Date']");
      
      // Wait for date field to be clickable
      await healer.waitFor("//*[@name='APTS_Signature_Expiry_Date__c']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_042: Enter Signature Expiry Date and Save
    // Calculate future date (20 days from now)
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 20);
    const formattedDate = `${(futureDate.getMonth() + 1).toString().padStart(2, '0')}/${futureDate.getDate().toString().padStart(2, '0')}/${futureDate.getFullYear()}`;
    
    await timedAction(userId, 'Step_042_Enterprise_SignatureExpiryDate_Save', async () => {
      // Enter date
      await healer.fill("//*[@name='APTS_Signature_Expiry_Date__c']", formattedDate);
      
      // Click SaveEdit button
      await healer.click("//*[@name='SaveEdit']");
      
      // Wait until Edit Signature Expiry Date button is clickable again
      await healer.waitFor("//*[@title='Edit Signature Expiry Date']", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_043: Click Generate Button
    // Scroll to Actions tab (NOT measured)
    const actionsTab = await healer.locator("//*[@title='Actions']");
    await actionsTab.scrollIntoViewIfNeeded();
    
    await timedAction(userId, 'Step_043_Enterprise_Click_Generate_Button', async () => {
      // Click Generate button
      await healer.click("//*[@alt='Generate']/parent::a");
      
      // Wait for Enterprise Order Form radio button to be clickable
      await healer.waitFor("//*[text()='Enterprise Order Form']/ancestor::tr[1]/td[1]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(6000);  // Think time after step (uses ConstantTimer1)
    
    // Step_044: Select Enterprise Order Form and Generate
    // Scroll and select radio button (NOT measured)
    await page.evaluate(() => window.scrollBy(0, 150));
    await healer.click("//*[text()='Enterprise Order Form']/ancestor::tr[1]/td[1]/span/input");
    await page.waitForTimeout(4000);  // Wait 4 seconds
    
    // Step_044: Click Generate (MEASURED)
    await timedAction(userId, 'Step_044_Enterprise_Select_SUREPREPOrderForm_Click_Generate_Button', async () => {
      // Click Generate button (2nd one)
      await healer.click("(//*[@value='Generate'])[2]");
      
      // Wait for Return button to be clickable
      await healer.waitFor("(//*[@value='Return'])[1]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer_Max)
    
    // Step_045: Click Return Button Back to Quote Page
    await timedAction(userId, 'Step_045_Enterprise_Click_ReturnButton_Backto_QuotePage', async () => {
      // Click Return button
      await healer.click("(//*[@value='Return'])[1]");
      
      // Scroll Actions tab into view
      const actionsTab = await healer.locator("//*[@title='Actions']");
      await actionsTab.scrollIntoViewIfNeeded();
      
      // Wait for Send For eSignatures link to appear
      await healer.waitFor("//*[@alt='Send For eSignatures']/parent::a", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Step_046: Click Send For eSignatures
    await timedAction(userId, 'Step_046_Enterprise_eSignature_Click', async () => {
      // Click Send For eSignatures button using JavaScript
      await healer.click("//*[@alt='Send For eSignatures']/parent::a");
      
      // Wait for "Select All" checkbox to be clickable
      await healer.waitFor("//input[contains(@onclick,'selectAll')]", { timeout: config.explicitWait });
    });
    await page.waitForTimeout(6000);  // Think time after step (uses ConstantTimer1)
    
    // Step_047: Select Files and Click Send for eSignature
    // Click Select All checkbox (NOT measured - form interaction)
    await healer.click("//input[contains(@onclick,'selectAll')]");
    await page.waitForTimeout(3000);  // Wait 3 seconds
    
    // Step_047: Click Send for e-signature (MEASURED)
    await timedAction(userId, 'Step_047_Enterprise_SelectFile_Click_Send_for_eSignature', async () => {
      // Click send for e-signature button
      await healer.click("//*[@id='attachment_send']");
      
      // Wait for Presented tab to appear (240 second timeout)
      await healer.waitFor("//*[@data-tab-name='Presented']", { timeout: 240000 });
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step (uses ConstantTimer_Max)
    
    // Step_048: Logout
    await page.waitForTimeout(5000);  // Wait 5 seconds before logout
    
    await timedAction(userId, 'Step_048_Enterprise_Click_Logout', async () => {
      // Simply quit the driver (logout handled by browser close)
      // Note: The browser will be automatically closed by runParallelTest
      // This step just marks the completion timing
      await page.waitForTimeout(100);  // Small delay to mark completion
    });
    await page.waitForTimeout(config.constantTimer);  // Think time after step
    
    // Get ML-powered self-healing statistics WITH PERFORMANCE METRICS
    const healingStats = healer.getStats();
    console.log(`✅ User ${userId}: Iteration ${iterationNumber} completed (ALL 48 STEPS)`);
    console.log(`🤖 ML Healing Stats - Total: ${healingStats.total}, ML Healed: ${healingStats.mlHealed}, Client Healed: ${healingStats.clientHealed}, Failed: ${healingStats.failed}`);
    console.log(`📊 Success Rate: ${healingStats.successRate}% | ML Usage: ${healingStats.mlUsageRate}%`);
    console.log(`⏱️  Performance: ${healingStats.performanceImpact} | Avg: ${healingStats.avgHealingTimeMs}ms`);
    
    return { 
      success: true, 
      userId, 
      iteration: iterationNumber, 
      steps: '1-48',
      healingStats 
    };
    
  } catch (error) {
    console.error(`❌ User ${userId}: Error: ${error.message}`);
    
    // Log any healing failures with performance data
    const healingStats = healer.getStats();
    console.error(`🤖 ML Healing Stats at failure - ML: ${healingStats.mlHealed}, Client: ${healingStats.clientHealed}, Failed: ${healingStats.failed}`);
    console.error(`⏱️  Performance Impact: ${healingStats.performanceImpact}`);
    
    return { success: false, userId, iteration: iterationNumber, error: error.message };
  } finally {
    // 🎯 ALWAYS generate API tests if API generator was enabled (even on failure)
    if (apiGen) {
      try {
        console.log('\n🎬 Generating API test scripts from captured calls...');
        await apiGen.saveGeneratedTests();
        console.log('✅ API test generation complete!');
      } catch (genError) {
        console.error(`⚠️  API generation failed: ${genError.message}`);
      }
    }
  }
  // Note: Browser cleanup happens automatically in runParallelTest
}

async function main() {
  console.log('🔐 Fetching Salesforce credentials from AWS Secrets Manager...');
  salesforceCredentials = await getSalesforceCredentials();
  console.log('✅ Credentials loaded successfully');
  
  console.log('🤖 Starting tests with ML-powered self-healing (hybrid mode: ML + client fallback)');
  const results = await runParallelTest(runUser, config);
  
  console.log(`\n[EXIT] Script completing with ${results.totalFailures > 0 ? 'FAILURES' : 'SUCCESS'}`);
  
  // Give a brief moment for any pending I/O to flush
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // CRITICAL: DO NOT call process.exit() here!
  // The script must complete naturally so entrypoint.sh can continue to upload results.
  // Entry point.sh will detect the exit code from Node.js automatically.
  const exitCode = results.totalFailures > 0 ? 1 : 0;
  console.log(`[EXIT] Script completed with exit code ${exitCode} - returning to entrypoint.sh for upload`);
  
  // Return the results object for potential programmatic use
  return results;
}

main().catch(error => {
  console.error(`❌ [FATAL] Unhandled error in main: ${error.message}`);
  console.error(error.stack);
  
  // CRITICAL: DO NOT call process.exit() - it kills container before upload!
  // Just throw the error and let Node.js exit naturally with code 1
  // This allows entrypoint.sh to upload partial results/screenshots
  throw error;
});
