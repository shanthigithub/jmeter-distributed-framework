/**
 * Smart API Generator with JMeter Support
 * 
 * Automatically captures API calls from Playwright browser tests and generates:
 * 1. Playwright API test (10-100 users)
 * 2. k6 load test (100-1000+ users)
 * 3. JMeter .jmx file (100-10,000+ users)
 * 
 * Features:
 * - Transaction grouping
 * - Parallel call detection
 * - Automatic correlation extraction
 * - Dynamic value replacement
 */

const fs = require('fs').promises;

class SmartAPIGeneratorWithJMeter {
  constructor(options = {}) {
    this.transactions = [];
    this.currentTransaction = null;
    this.correlationMap = new Map();
    this.variableCounter = 0;
    this.parallelThreshold = options.parallelThreshold || 100; // ms
    this.outputDir = options.outputDir || './generated-api-tests';
  }

  /**
   * Hook into Playwright page to capture API calls
   */
  async captureFromBrowser(page) {
    console.log('🎥 API Capture enabled - analyzing transactions...\n');
    
    let requestMap = new Map();

    // Capture all API requests
    page.on('request', request => {
      if (this.isAPICall(request)) {
        const call = {
          method: request.method(),
          url: request.url(),
          headers: this.sanitizeHeaders(request.headers()),
          body: request.postData(),
          timestamp: Date.now(),
          requestId: `${request.url()}_${Date.now()}`
        };

        this.detectCorrelationsInRequest(call);
        requestMap.set(call.requestId, call);
      }
    });

    // Capture all API responses
    page.on('response', async response => {
      const request = response.request();
      
      // Find matching request
      let call = null;
      for (const [key, value] of requestMap.entries()) {
        if (key.startsWith(request.url())) {
          call = value;
          requestMap.delete(key);
          break;
        }
      }

      if (call && this.currentTransaction) {
        call.status = response.status();
        call.responseTime = Date.now() - call.timestamp;
        
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            call.responseBody = await response.json();
            this.extractCorrelations(call);
          }
        } catch (e) {
          call.responseBody = null;
        }

        // Double-check transaction still exists before pushing (async race condition)
        if (this.currentTransaction && this.currentTransaction.apiCalls) {
          this.currentTransaction.apiCalls.push(call);
          console.log(`📡 Captured: ${call.method} ${this.getShortUrl(call.url)}`);
          console.log(`✅ Response: ${call.status} (${call.responseTime}ms)`);
        }
      }
    });
  }

  /**
   * Start a new transaction (user action grouping)
   */
  startTransaction(name) {
    this.currentTransaction = {
      name: name,
      startTime: Date.now(),
      apiCalls: [],
      parallelGroups: [],
      correlations: []
    };
    console.log(`\n📦 Transaction started: ${name}`);
  }

  /**
   * Wait for all pending API calls to complete (network idle)
   * Monitors API activity and waits until no new calls for specified duration
   * @param {number} idleTime - Milliseconds of idle time to wait for (default 1000ms)
   * @param {number} maxWait - Maximum time to wait (default 10000ms)
   * @returns {Promise<void>}
   */
  async waitForAPIsToSettle(idleTime = 1000, maxWait = 10000) {
    if (!this.currentTransaction) return;
    
    const startTime = Date.now();
    let lastApiTime = Date.now();
    const initialCount = this.currentTransaction.apiCalls.length;
    
    console.log(`⏳ Waiting for APIs to settle (idle: ${idleTime}ms, max: ${maxWait}ms)...`);
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const currentCount = this.currentTransaction.apiCalls.length;
        const elapsed = Date.now() - startTime;
        const timeSinceLastApi = Date.now() - lastApiTime;
        
        // Update last API time if new APIs arrived
        if (currentCount > initialCount && this.currentTransaction.apiCalls.length > 0) {
          const lastApi = this.currentTransaction.apiCalls[this.currentTransaction.apiCalls.length - 1];
          if (lastApi.timestamp > lastApiTime) {
            lastApiTime = lastApi.timestamp;
          }
        }
        
        // Check if we should stop waiting
        if (timeSinceLastApi >= idleTime || elapsed >= maxWait) {
          clearInterval(checkInterval);
          const totalCaptured = currentCount - initialCount;
          console.log(`✅ APIs settled: ${totalCaptured} calls captured in ${elapsed}ms`);
          resolve();
        }
      }, 100); // Check every 100ms
    });
  }

  /**
   * End current transaction and detect parallel calls
   */
  endTransaction() {
    if (this.currentTransaction) {
      this.currentTransaction.duration = Date.now() - this.currentTransaction.startTime;
      this.detectParallelCalls();
      this.transactions.push(this.currentTransaction);
      
      console.log(`✅ Transaction completed: ${this.currentTransaction.name} (${this.currentTransaction.duration}ms)`);
      console.log(`   └─ Parallel groups found: ${this.currentTransaction.parallelGroups.filter(g => g.type === 'parallel').length}`);
      
      this.currentTransaction = null;
    }
  }

  /**
   * Detect which API calls happened in parallel
   */
  detectParallelCalls() {
    if (!this.currentTransaction || this.currentTransaction.apiCalls.length === 0) {
      return;
    }

    const calls = this.currentTransaction.apiCalls;
    const groups = [];
    let currentGroup = [calls[0]];
    
    for (let i = 1; i < calls.length; i++) {
      const prevCall = calls[i - 1];
      const currentCall = calls[i];
      const timeDiff = currentCall.timestamp - prevCall.timestamp;
      
      if (timeDiff <= this.parallelThreshold) {
        currentGroup.push(currentCall);
        console.log(`🔀 Detected parallel call: ${currentCall.method} ${this.getShortUrl(currentCall.url)} (Δ${timeDiff}ms)`);
      } else {
        if (currentGroup.length > 0) {
          groups.push({
            type: currentGroup.length > 1 ? 'parallel' : 'sequential',
            calls: currentGroup,
            startTime: currentGroup[0].timestamp
          });
        }
        currentGroup = [currentCall];
      }
    }
    
    if (currentGroup.length > 0) {
      groups.push({
        type: currentGroup.length > 1 ? 'parallel' : 'sequential',
        calls: currentGroup,
        startTime: currentGroup[0].timestamp
      });
    }

    this.currentTransaction.parallelGroups = groups;
  }

  /**
   * Check if request is an API call (not static resources)
   */
  isAPICall(request) {
    const url = request.url();
    const method = request.method();
    
    // Salesforce API patterns
    if (url.includes('/services/data/') ||
        url.includes('/services/apexrest/') ||
        url.includes('/services/Soap/') ||
        url.includes('/aura?') ||
        url.includes('/apex/')) {
      return true;
    }
    
    // API methods to non-static resources
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) &&
        !url.match(/\.(js|css|png|jpg|gif|woff|svg|ico)$/)) {
      return true;
    }
    
    return false;
  }

  /**
   * Detect if request uses previously extracted correlation values
   */
  detectCorrelationsInRequest(call) {
    if (!call.body) return;

    try {
      const bodyStr = call.body;
      
      for (const [key, value] of this.correlationMap.entries()) {
        if (bodyStr.includes(value.toString())) {
          call.usesCorrelation = call.usesCorrelation || [];
          call.usesCorrelation.push({
            variable: key,
            value: value,
            location: 'body'
          });
          console.log(`🔗 Uses correlation: ${key}`);
        }
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  /**
   * Extract dynamic values from response for correlation
   */
  extractCorrelations(call) {
    if (!call.responseBody || call.status >= 400) return;

    const patterns = [
      { 
        pattern: /^[a-zA-Z0-9]{18}$/,
        type: 'salesforce_id',
        paths: ['id', 'Id']
      },
      {
        pattern: /.{50,}/,
        type: 'session_token',
        paths: ['access_token', 'sessionId', 'session_id']
      }
    ];

    patterns.forEach(({ pattern, type, paths }) => {
      paths.forEach(path => {
        const value = this.getNestedValue(call.responseBody, path);
        if (value && pattern.test(value.toString())) {
          const varName = this.generateVariableName(type, call);
          
          const correlation = {
            variable: varName,
            value: value,
            type: type,
            extractPath: path,
            sourceUrl: call.url,
            sourceMethod: call.method
          };

          if (!call.correlations) call.correlations = [];
          call.correlations.push(correlation);
          this.currentTransaction.correlations.push(correlation);
          this.correlationMap.set(varName, value);
          
          console.log(`🔗 Extracted correlation: ${varName} = ${value.substring(0, 20)}...`);
        }
      });
    });
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  generateVariableName(type, call) {
    this.variableCounter++;
    
    if (type === 'salesforce_id') {
      if (call.url.includes('/Account')) return `accountId_${this.variableCounter}`;
      if (call.url.includes('/Contact')) return `contactId_${this.variableCounter}`;
      if (call.url.includes('/Opportunity')) return `opportunityId_${this.variableCounter}`;
    }
    
    return `${type}_${this.variableCounter}`;
  }

  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    delete sanitized['cookie'];
    delete sanitized['authorization'];
    return sanitized;
  }

  getShortUrl(url) {
    try {
      const parsed = new URL(url);
      return (parsed.pathname + parsed.search).substring(0, 60);
    } catch {
      return url.substring(0, 60);
    }
  }

  escapeXml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  getBaseURL() {
    if (this.transactions.length === 0 || this.transactions[0].apiCalls.length === 0) {
      return 'https://your-instance.salesforce.com';
    }
    try {
      const url = new URL(this.transactions[0].apiCalls[0].url);
      return `${url.protocol}//${url.host}`;
    } catch {
      return 'https://your-instance.salesforce.com';
    }
  }

  replaceCorrelations(text, call) {
    if (!call.usesCorrelation || !text) return text;
    
    let result = text;
    call.usesCorrelation.forEach(corr => {
      result = result.replace(corr.value, `\${correlations.${corr.variable}}`);
    });
    return result;
  }

  /**
   * Generate Playwright API test
   */
  generatePlaywrightTest() {
    return `/**
 * AUTO-GENERATED Playwright API Test
 * Generated: ${new Date().toISOString()}
 * Transactions: ${this.transactions.length}
 * API Calls: ${this.transactions.reduce((sum, t) => sum + t.apiCalls.length, 0)}
 * Correlations: ${this.correlationMap.size}
 */

const { request } = require('@playwright/test');

const config = {
  baseURL: '${this.getBaseURL()}',
  accessToken: process.env.ACCESS_TOKEN || 'YOUR_TOKEN_HERE',
  parallelUsers: parseInt(process.env.PARALLEL_USERS || '10'),
  iterations: parseInt(process.env.ITERATIONS || '1')
};

async function runAPITest(userId) {
  const apiContext = await request.newContext({
    baseURL: config.baseURL,
    extraHTTPHeaders: {
      'Authorization': \`Bearer \${config.accessToken}\`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  const correlations = {};
  
  try {
${this.transactions.map((tx, idx) => this.generatePlaywrightTransaction(tx, idx)).join('\n')}
    
    console.log(\`✅ User \${userId} completed successfully\`);
    return { success: true, userId };
    
  } catch (error) {
    console.error(\`❌ User \${userId} failed: \${error.message}\`);
    return { success: false, userId, error: error.message };
  } finally {
    await apiContext.dispose();
  }
}

async function main() {
  const promises = [];
  
  for (let user = 1; user <= config.parallelUsers; user++) {
    for (let iter = 1; iter <= config.iterations; iter++) {
      promises.push(runAPITest(user));
    }
  }
  
  const results = await Promise.all(promises);
  const failures = results.filter(r => !r.success);
  
  console.log(\`\\n📊 Results: \${results.length} total, \${failures.length} failed\`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
`;
  }

  generatePlaywrightTransaction(transaction, txIdx) {
    return `    // Transaction: ${transaction.name}
    console.log('\\n📦 ${transaction.name}');
${transaction.parallelGroups.map((group, groupIdx) => {
  if (group.type === 'parallel') {
    return this.generatePlaywrightParallelGroup(group, txIdx, groupIdx);
  } else {
    return this.generatePlaywrightSequentialCall(group.calls[0], txIdx, groupIdx);
  }
}).join('\n')}`;
  }

  generatePlaywrightParallelGroup(group, txIdx, groupIdx) {
    const calls = group.calls;
    return `    const parallel_${txIdx}_${groupIdx} = await Promise.all([
${calls.map(call => {
  const url = this.replaceCorrelations(call.url.replace(this.getBaseURL(), ''), call);
  const body = call.body ? this.replaceCorrelations(call.body, call) : null;
  return `      apiContext.${call.method.toLowerCase()}(\`${url}\`, { ${body ? `data: JSON.parse(\`${body}\`),` : ''} timeout: 30000 })`;
}).join(',\n')}
    ]);
${calls.map((call, idx) => {
  let code = `    console.log(\`  ├─ [Parallel] ${call.method} ${this.getShortUrl(call.url)}: \${parallel_${txIdx}_${groupIdx}[${idx}].status()}\`);`;
  if (call.correlations) {
    call.correlations.forEach(corr => {
      code += `\n    correlations.${corr.variable} = (await parallel_${txIdx}_${groupIdx}[${idx}].json()).${corr.extractPath};`;
    });
  }
  return code;
}).join('\n')}`;
  }

  generatePlaywrightSequentialCall(call, txIdx, groupIdx) {
    const url = this.replaceCorrelations(call.url.replace(this.getBaseURL(), ''), call);
    const body = call.body ? this.replaceCorrelations(call.body, call) : null;
    
    let code = `    const response_${txIdx}_${groupIdx} = await apiContext.${call.method.toLowerCase()}(\`${url}\`, { ${body ? `data: JSON.parse(\`${body}\`),` : ''} timeout: 30000 });
    console.log(\`  ├─ ${call.method} ${this.getShortUrl(call.url)}: \${response_${txIdx}_${groupIdx}.status()}\`);`;
    
    if (call.correlations) {
      call.correlations.forEach(corr => {
        code += `\n    correlations.${corr.variable} = (await response_${txIdx}_${groupIdx}.json()).${corr.extractPath};`;
      });
    }
    return code;
  }

  /**
   * Generate k6 load test
   */
  generateK6Test() {
    return `/**
 * AUTO-GENERATED k6 Load Test
 * Generated: ${new Date().toISOString()}
 * Transactions: ${this.transactions.length}
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export let options = {
  vus: __ENV.VUS || 100,
  duration: __ENV.DURATION || '5m',
  thresholds: {
    'http_req_duration': ['p(95)<2000'],
    'errors': ['rate<0.1'],
  },
};

const BASE_URL = '${this.getBaseURL()}';
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN || 'YOUR_TOKEN_HERE';

export default function() {
  const correlations = {};
  
${this.transactions.map((tx, idx) => `  group('${tx.name}', function() {
${tx.parallelGroups.map((group, gIdx) => {
  if (group.type === 'parallel') {
    return this.generateK6ParallelGroup(group, idx, gIdx);
  } else {
    return this.generateK6SequentialCall(group.calls[0], idx, gIdx);
  }
}).join('\n')}
  });`).join('\n\n')}

  sleep(1);
}

function extractJSON(response, path) {
  try {
    const body = JSON.parse(response.body);
    return path.split('.').reduce((obj, key) => obj[key], body);
  } catch (e) {
    return null;
  }
}
`;
  }

  generateK6ParallelGroup(group, txIdx, groupIdx) {
    return `    let batch_${txIdx}_${groupIdx} = {
${group.calls.map((call, idx) => {
  const url = this.replaceCorrelations(call.url, call);
  const body = call.body ? this.replaceCorrelations(call.body, call) : null;
  return `      'call_${idx}': { method: '${call.method}', url: \`${url}\`, ${body ? `body: \`${body}\`,` : ''} params: { headers: { 'Authorization': \`Bearer \${ACCESS_TOKEN}\`, 'Content-Type': 'application/json' } } }`;
}).join(',\n')}
    };
    let responses_${txIdx}_${groupIdx} = http.batch(batch_${txIdx}_${groupIdx});
${group.calls.map((call, idx) => {
  let code = `    check(responses_${txIdx}_${groupIdx}['call_${idx}'], { 'status ${call.status}': (r) => r.status === ${call.status} }) || errorRate.add(1);`;
  if (call.correlations) {
    call.correlations.forEach(corr => {
      code += `\n    correlations.${corr.variable} = extractJSON(responses_${txIdx}_${groupIdx}['call_${idx}'], '${corr.extractPath}');`;
    });
  }
  return code;
}).join('\n')}`;
  }

  generateK6SequentialCall(call, txIdx, groupIdx) {
    const url = this.replaceCorrelations(call.url, call);
    const body = call.body ? this.replaceCorrelations(call.body, call) : null;
    
    let code = `    let response_${txIdx}_${groupIdx} = http.${call.method.toLowerCase()}(\`${url}\`, ${body ? `\`${body}\`,` : 'null,'} { headers: { 'Authorization': \`Bearer \${ACCESS_TOKEN}\`, 'Content-Type': 'application/json' } });
    check(response_${txIdx}_${groupIdx}, { 'status ${call.status}': (r) => r.status === ${call.status} }) || errorRate.add(1);`;
    
    if (call.correlations) {
      call.correlations.forEach(corr => {
        code += `\n    correlations.${corr.variable} = extractJSON(response_${txIdx}_${groupIdx}, '${corr.extractPath}');`;
      });
    }
    return code;
  }

  /**
   * Generate JMeter .jmx file
   */
  generateJMeterTest() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Auto-Generated API Test">
      <stringProp name="TestPlan.comments">Generated: ${new Date().toISOString()}</stringProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          <elementProp name="BASE_URL" elementType="Argument">
            <stringProp name="Argument.name">BASE_URL</stringProp>
            <stringProp name="Argument.value">${this.getBaseURL()}</stringProp>
          </elementProp>
          <elementProp name="ACCESS_TOKEN" elementType="Argument">
            <stringProp name="Argument.name">ACCESS_TOKEN</stringProp>
            <stringProp name="Argument.value">\${__P(ACCESS_TOKEN,)}</stringProp>
          </elementProp>
        </collectionProp>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="API Users">
        <stringProp name="ThreadGroup.num_threads">\${__P(threads,100)}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">\${__P(rampup,60)}</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
          <stringProp name="LoopController.loops">\${__P(iterations,1)}</stringProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
${this.transactions.map(tx => this.generateJMeterTransaction(tx)).join('\n')}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
  }

  generateJMeterTransaction(transaction) {
    return `        <TransactionController guiclass="TransactionControllerGui" testclass="TransactionController" testname="${transaction.name}">
          <boolProp name="TransactionController.parent">true</boolProp>
        </TransactionController>
        <hashTree>
${transaction.apiCalls.map(call => this.generateJMeterHTTPRequest(call)).join('\n')}
        </hashTree>`;
  }

  generateJMeterHTTPRequest(call) {
    const url = new URL(call.url);
    const path = url.pathname + url.search;
    let body = call.body || '';
    
    if (call.usesCorrelation) {
      call.usesCorrelation.forEach(corr => {
        body = body.replace(corr.value, `\${${corr.variable}}`);
      });
    }

    return `          <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${this.escapeXml(call.method + ' ' + this.getShortUrl(call.url))}">
            <stringProp name="HTTPSampler.domain">\${BASE_URL}</stringProp>
            <stringProp name="HTTPSampler.path">${this.escapeXml(path)}</stringProp>
            <stringProp name="HTTPSampler.method">${call.method}</stringProp>
            ${body ? `<boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
            <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
              <collectionProp name="Arguments.arguments">
                <elementProp name="" elementType="HTTPArgument">
                  <boolProp name="HTTPArgument.always_encode">false</boolProp>
                  <stringProp name="Argument.value"><![CDATA[${body}]]></stringProp>
                </elementProp>
              </collectionProp>
            </elementProp>` : ''}
          </HTTPSamplerProxy>
          <hashTree>
            <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="Headers">
              <collectionProp name="HeaderManager.headers">
                <elementProp name="" elementType="Header">
                  <stringProp name="Header.name">Authorization</stringProp>
                  <stringProp name="Header.value">Bearer \${ACCESS_TOKEN}</stringProp>
                </elementProp>
                <elementProp name="" elementType="Header">
                  <stringProp name="Header.name">Content-Type</stringProp>
                  <stringProp name="Header.value">application/json</stringProp>
                </elementProp>
              </collectionProp>
            </HeaderManager>
            <hashTree/>
${call.correlations ? call.correlations.map(corr => `            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${corr.variable}">
              <stringProp name="JSONPostProcessor.referenceNames">${corr.variable}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">$.${corr.extractPath}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
            </JSONPostProcessor>
            <hashTree/>`).join('\n') : ''}
          </hashTree>`;
  }

  /**
   * Save all generated test files
   */
  async saveGeneratedTests() {
    await fs.mkdir(this.outputDir, { recursive: true });

    console.log(`\n📁 Saving generated tests to: ${this.outputDir}/`);

    // Save Playwright test
    await fs.writeFile(
      `${this.outputDir}/playwright-api-test.js`,
      this.generatePlaywrightTest()
    );
    console.log(`✅ Playwright test: ${this.outputDir}/playwright-api-test.js`);

    // Save k6 test
    await fs.writeFile(
      `${this.outputDir}/k6-load-test.js`,
      this.generateK6Test()
    );
    console.log(`✅ k6 test: ${this.outputDir}/k6-load-test.js`);

    // Save JMeter test
    await fs.writeFile(
      `${this.outputDir}/jmeter-api-test.jmx`,
      this.generateJMeterTest()
    );
    console.log(`✅ JMeter test: ${this.outputDir}/jmeter-api-test.jmx`);

    // Save analysis report
    const analysis = {
      generated: new Date().toISOString(),
      transactions: this.transactions.length,
      totalAPICalls: this.transactions.reduce((sum, t) => sum + t.apiCalls.length, 0),
      parallelGroups: this.transactions.reduce((sum, t) => sum + t.parallelGroups.filter(g => g.type === 'parallel').length, 0),
      correlations: this.correlationMap.size,
      transactionDetails: this.transactions.map(tx => ({
        name: tx.name,
        apiCalls: tx.apiCalls.length,
        duration: tx.duration,
        correlations: tx.correlations.length
      }))
    };
    await fs.writeFile(
      `${this.outputDir}/api-analysis.json`,
      JSON.stringify(analysis, null, 2)
    );
    console.log(`✅ Analysis report: ${this.outputDir}/api-analysis.json`);

    console.log(`\n🎉 Generated:`);
    console.log(`   - ${this.transactions.length} transactions`);
    console.log(`   - ${analysis.totalAPICalls} API calls`);
    console.log(`   - ${this.correlationMap.size} correlations detected`);
    console.log(`   - ${analysis.parallelGroups} parallel groups identified\n`);
  }
}

module.exports = { SmartAPIGeneratorWithJMeter };
