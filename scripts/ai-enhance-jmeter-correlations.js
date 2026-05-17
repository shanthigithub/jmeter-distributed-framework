#!/usr/bin/env node

/**
 * AI-Enhanced JMeter Correlation Script
 * 
 * This script uses Claude AI to analyze generated JMeter files and:
 * 1. Detect missing correlations
 * 2. Replace hardcoded values with JMeter variables
 * 3. Add proper extractors
 * 
 * Usage:
 *   node scripts/ai-enhance-jmeter-correlations.js <input.jmx> [output.jmx]
 *   
 * Environment:
 *   ANTHROPIC_API_KEY - Your Claude API key
 */

const fs = require('fs').promises;
const path = require('path');
const { AICorrelationAnalyzer } = require('../lib/ai-correlation-analyzer');

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3] || inputFile.replace('.jmx', '-ai-enhanced.jmx');

  if (!inputFile) {
    console.error('Usage: node scripts/ai-enhance-jmeter-correlations.js <input.jmx> [output.jmx]');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY environment variable not set');
    console.error('   Get your API key from: https://console.anthropic.com/');
    process.exit(1);
  }

  console.log(`\n🚀 AI-Enhanced Correlation Analysis`);
  console.log(`   Input:  ${inputFile}`);
  console.log(`   Output: ${outputFile}`);

  // Read the JMeter file
  const jmxContent = await fs.readFile(inputFile, 'utf-8');
  console.log(`\n📖 Read JMeter file: ${(jmxContent.length / 1024).toFixed(1)} KB`);

  // Parse API calls from JMeter file
  const apiCalls = parseJMeterAPIsCalls(jmxContent);
  console.log(`📊 Extracted ${apiCalls.length} API calls from JMeter file`);

  // Initialize AI analyzer
  const analyzer = new AICorrelationAnalyzer(process.env.ANTHROPIC_API_KEY);

  // Add all API calls for analysis
  apiCalls.forEach(call => analyzer.addAPICall(call));

  // Run AI analysis
  const correlations = await analyzer.analyzeCorrelations();

  if (correlations.length === 0) {
    console.log(`\n⚠️  No correlations detected by AI`);
    console.log(`   Your JMeter file may already be properly correlated`);
    return;
  }

  // Apply correlations to JMeter
  let enhancedJmx = analyzer.applyCorrelationsToJMeter(jmxContent);

  // Insert extractors at appropriate locations
  enhancedJmx = insertJMeterExtractors(enhancedJmx, analyzer.correlations, apiCalls);

  // Save enhanced JMeter file
  await fs.writeFile(outputFile, enhancedJmx);
  console.log(`\n✅ Enhanced JMeter file saved: ${outputFile}`);

  // Generate report
  const reportPath = outputFile.replace('.jmx', '-correlation-report.json');
  await analyzer.generateReport(reportPath);

  console.log(`\n📈 Summary:`);
  console.log(`   API Calls Analyzed: ${apiCalls.length}`);
  console.log(`   Correlations Found: ${correlations.length}`);
  console.log(`   File Size: ${(jmxContent.length / 1024).toFixed(1)} KB → ${(enhancedJmx.length / 1024).toFixed(1)} KB`);
  console.log(`\n✨ Done! Open ${outputFile} in JMeter to see the enhanced test.`);
}

/**
 * Parse API calls from JMeter XML
 */
function parseJMeterAPIsCalls(jmxContent) {
  const calls = [];
  const httpSamplerRegex = /<HTTPSamplerProxy[^>]*testname="([^"]+)"[^>]*>([\s\S]*?)<\/HTTPSamplerProxy>/g;
  
  let match;
  let sequence = 1;
  
  while ((match = httpSamplerRegex.exec(jmxContent)) !== null) {
    const samplerName = match[1];
    const samplerBody = match[2];
    
    // Extract path
    const pathMatch = samplerBody.match(/<stringProp name="HTTPSampler\.path">([^<]*)<\/stringProp>/);
    const path = pathMatch ? pathMatch[1] : '';
    
    // Extract method
    const methodMatch = samplerBody.match(/<stringProp name="HTTPSampler\.method">([^<]*)<\/stringProp>/);
    const method = methodMatch ? methodMatch[1] : 'GET';
    
    // Extract body
    const bodyMatch = samplerBody.match(/<stringProp name="Argument\.value"><!\[CDATA\[([\s\S]*?)\]\]><\/stringProp>/);
    const body = bodyMatch ? bodyMatch[1] : null;
    
    calls.push({
      sequence: sequence++,
      method,
      url: `https://example.com${path}`, // Placeholder domain
      body,
      responseBody: null, // Not available from JMeter file
      status: 200 // Assume success
    });
  }
  
  return calls;
}

/**
 * Insert JMeter extractors at appropriate locations in XML
 */
function insertJMeterExtractors(jmxContent, correlations, apiCalls) {
  let result = jmxContent;
  
  correlations.forEach(corr => {
    const requestNumber = corr.extractFromRequestNumber;
    const call = apiCalls[requestNumber - 1];
    
    if (!call) return;
    
    // Find the HTTPSamplerProxy for this request
    const samplerRegex = new RegExp(
      `(<HTTPSamplerProxy[^>]*testname="${escapeRegex(call.method)}[^"]*"[^>]*>[\\s\\S]*?<HeaderManager[\\s\\S]*?<\/hashTree>)`,
      'g'
    );
    
    const extractor = `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="AI: Extract ${corr.variableName}">
              <stringProp name="JSONPostProcessor.referenceNames">${corr.variableName}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${corr.jsonPath}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="Scope.variable"></stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">AI_EXTRACTION_FAILED</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    
    result = result.replace(samplerRegex, `$1${extractor}`);
  });
  
  return result;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run the script
main().catch(error => {
  console.error(`\n❌ Error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});