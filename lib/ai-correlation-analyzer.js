/**
 * AI-Powered Correlation Analyzer
 * 
 * Uses Claude AI to intelligently detect correlations between
 * API responses and subsequent requests - similar to how Fiddler
 * AutoCorrelate works but with LLM intelligence.
 * 
 * Features:
 * - Analyzes request/response pairs with AI
 * - Detects dynamic values that need correlation
 * - Identifies where extracted values are used
 * - Generates JMeter extractors and variable replacements
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;

class AICorrelationAnalyzer {
  constructor(apiKey) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY
    });
    this.correlations = [];
    this.apiCalls = [];
  }

  /**
   * Add API call for analysis
   */
  addAPICall(call) {
    this.apiCalls.push({
      sequence: this.apiCalls.length + 1,
      method: call.method,
      url: call.url,
      requestBody: call.body,
      responseStatus: call.status,
      responseBody: call.responseBody,
      headers: call.headers
    });
  }

  /**
   * Analyze all API calls using Claude AI to detect correlations
   */
  async analyzeCorrelations() {
    console.log(`\n🤖 AI Correlation Analysis Starting...`);
    console.log(`   Analyzing ${this.apiCalls.length} API calls with Claude AI`);

    const prompt = this.buildAnalysisPrompt();
    
    try {
      const message = await this.client.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 8000,
        messages: [{
          role: "user",
          content: prompt
        }]
      });

      const analysis = JSON.parse(message.content[0].text);
      this.correlations = analysis.correlations || [];

      console.log(`✅ AI Analysis Complete!`);
      console.log(`   Found ${this.correlations.length} correlations`);
      
      this.correlations.forEach((corr, idx) => {
        console.log(`\n   Correlation ${idx + 1}:`);
        console.log(`   └─ Variable: ${corr.variableName}`);
        console.log(`   └─ Extract from: Request #${corr.extractFromRequestNumber}`);
        console.log(`   └─ Used in: ${corr.usedInRequests.join(', ')}`);
        console.log(`   └─ JSON Path: ${corr.jsonPath}`);
      });

      return this.correlations;

    } catch (error) {
      console.error(`❌ AI Analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Build comprehensive prompt for Claude AI
   */
  buildAnalysisPrompt() {
    const callsSummary = this.apiCalls.map((call, idx) => {
      return `
## Request ${idx + 1}: ${call.method} ${call.url}

**Request Body:**
\`\`\`
${call.requestBody ? call.requestBody.substring(0, 1000) : 'No body'}
\`\`\`

**Response Status:** ${call.responseStatus}

**Response Body:**
\`\`\`json
${call.responseBody ? JSON.stringify(call.responseBody, null, 2).substring(0, 1000) : 'No response body'}
\`\`\`
`;
    }).join('\n---\n');

    return `You are an expert at analyzing HTTP API call sequences to detect correlations for performance testing.

Your task is to analyze this sequence of API calls and identify:
1. Dynamic values in response bodies that should be extracted
2. Where those extracted values are used in subsequent request bodies or URLs
3. The JSON path to extract each value
4. A descriptive variable name for each correlation

Look for common patterns:
- Session tokens, access tokens, JWT tokens
- CSRF tokens, nonce values
- Salesforce-specific: aura.token, fwuid, context tokens
- Record IDs (18-character Salesforce IDs)
- Dynamic timestamps, sequence numbers
- Any value that appears in a response and is reused in later requests

Here are the API calls in sequence:

${callsSummary}

Please analyze these calls and return a JSON object with this EXACT structure:

{
  "correlations": [
    {
      "variableName": "aura_token",
      "extractFromRequestNumber": 2,
      "jsonPath": "$.aura.token",
      "usedInRequests": [3, 4, 5],
      "valuePreview": "eyJub25jZSI6...",
      "description": "Aura framework token used in subsequent Aura API calls",
      "locationsInRequests": [
        {
          "requestNumber": 3,
          "location": "body",
          "searchPattern": "aura.token=<VALUE>"
        }
      ]
    }
  ]
}

Important:
- Only include correlations where the value is ACTUALLY reused
- Use JSONPath notation for extraction ($.field.nested)
- Be specific about where in the request body the value appears
- Request numbers start at 1
- Return ONLY the JSON, no additional text

Analyze now:`;
  }

  /**
   * Apply correlations to JMeter test plan
   */
  applyCorrelationsToJMeter(jmxContent) {
    console.log(`\n🔧 Applying ${this.correlations.length} AI-detected correlations to JMeter...`);

    let updatedJmx = jmxContent;
    let replacementCount = 0;

    this.correlations.forEach(corr => {
      // For each request that uses this correlation
      corr.usedInRequests.forEach(reqNum => {
        const call = this.apiCalls[reqNum - 1];
        if (!call || !call.requestBody) return;

        // Find the actual value in the source response
        const sourceCall = this.apiCalls[corr.extractFromRequestNumber - 1];
        if (!sourceCall || !sourceCall.responseBody) return;

        const actualValue = this.extractValueByPath(sourceCall.responseBody, corr.jsonPath);
        if (!actualValue) return;

        // Replace in JMeter (both plain and URL-encoded versions)
        const plainValue = actualValue.toString();
        const urlEncodedValue = encodeURIComponent(plainValue);

        // Escape for regex
        const escapedPlain = plainValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedEncoded = urlEncodedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Replace both versions
        const before = updatedJmx;
        updatedJmx = updatedJmx.replace(new RegExp(escapedPlain, 'g'), `\${${corr.variableName}}`);
        updatedJmx = updatedJmx.replace(new RegExp(escapedEncoded, 'g'), `\${${corr.variableName}}`);
        
        if (updatedJmx !== before) {
          replacementCount++;
          console.log(`   ✓ Replaced ${corr.variableName} in request #${reqNum}`);
        }
      });
    });

    console.log(`\n✅ Applied ${replacementCount} correlation replacements`);
    return updatedJmx;
  }

  /**
   * Extract value from JSON using JSONPath-like notation
   */
  extractValueByPath(obj, path) {
    // Simple JSONPath implementation ($.field.nested)
    const parts = path.replace(/^\$\./, '').split('.');
    let current = obj;
    
    for (const part of parts) {
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        return null;
      }
    }
    
    return current;
  }

  /**
   * Generate JMeter extractors from AI correlations
   */
  generateJMeterExtractors() {
    return this.correlations.map(corr => {
      const sourceCall = this.apiCalls[corr.extractFromRequestNumber - 1];
      
      return `            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${corr.variableName}">
              <stringProp name="JSONPostProcessor.referenceNames">${corr.variableName}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${corr.jsonPath}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">EXTRACTION_FAILED</stringProp>
              <stringProp name="Scope.variable"></stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    });
  }

  /**
   * Generate report of correlations found
   */
  async generateReport(outputPath) {
    const report = {
      timestamp: new Date().toISOString(),
      totalAPIsCalls: this.apiCalls.length,
      correlationsFound: this.correlations.length,
      correlations: this.correlations.map(corr => ({
        ...corr,
        extractFromURL: this.apiCalls[corr.extractFromRequestNumber - 1]?.url,
        usedInURLs: corr.usedInRequests.map(reqNum => 
          this.apiCalls[reqNum - 1]?.url
        )
      })),
      summary: `Found ${this.correlations.length} correlations across ${this.apiCalls.length} API calls`
    };

    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Correlation report saved: ${outputPath}`);
    return report;
  }
}

module.exports = { AICorrelationAnalyzer };