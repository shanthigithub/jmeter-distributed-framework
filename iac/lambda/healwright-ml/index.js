/**
 * Healwright ML Backend - DynamoDB Version
 * Cost-optimized serverless healing with DynamoDB
 * 
 * Estimated cost: $10-15/month for typical usage
 * - Lambda: $3-5/month
 * - DynamoDB: $5-8/month (on-demand)
 * - API Gateway: $2-3/month
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PATTERNS_TABLE = process.env.PATTERNS_TABLE || 'healwright-patterns';
const ATTEMPTS_TABLE = process.env.ATTEMPTS_TABLE || 'healwright-attempts';

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  console.log('Request:', JSON.stringify(event, null, 2));

  // Handle warming requests
  if (event.warm) {
    return { statusCode: 200, body: JSON.stringify({ status: 'warm' }) };
  }

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  // Health check
  if (event.httpMethod === 'GET' && event.path === '/health') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'dynamodb',
        version: '2.0.0'
      })
    };
  }

  // Handle OPTIONS for CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Healing endpoint
  if (event.httpMethod === 'POST' && (event.path === '/heal' || event.path === '/')) {
    try {
      const body = JSON.parse(event.body);
      const result = await healSelector(body);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result)
      };
    } catch (error) {
      console.error('Healing error:', error);
      return {
        statusCode: error.statusCode || 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: error.message
        })
      };
    }
  }

  return {
    statusCode: 404,
    headers,
    body: JSON.stringify({ error: 'Not found' })
  };
};

/**
 * Heal a selector using ML + historical patterns
 */
async function healSelector(request) {
  const startTime = Date.now();
  
  // Validate request
  if (!request.selector || !request.domSnapshot) {
    throw { statusCode: 400, message: 'Missing required fields: selector, domSnapshot' };
  }

  const { selector, domSnapshot, pageUrl, testId, previousAttempts = [] } = request;

  console.log(`Healing selector: ${selector} on ${pageUrl}`);

  // Step 1: Check historical patterns
  const historicalResult = await checkHistoricalPattern(selector, pageUrl);
  if (historicalResult) {
    await recordAttempt(selector, historicalResult.healedSelector, pageUrl, testId, true, 
                       historicalResult.confidence, 'historical', Date.now() - startTime);
    
    return {
      success: true,
      healedSelector: historicalResult.healedSelector,
      confidence: historicalResult.confidence,
      method: 'historical',
      cached: true,
      duration: Date.now() - startTime
    };
  }

  // Step 2: ML-based healing using DOM snapshot
  const mlResult = await performMLHealing(selector, domSnapshot, previousAttempts);
  
  if (mlResult.success) {
    // Store successful pattern
    await storePattern(selector, mlResult.healedSelector, pageUrl, mlResult.confidence);
    
    await recordAttempt(selector, mlResult.healedSelector, pageUrl, testId, true,
                       mlResult.confidence, 'ml-analysis', Date.now() - startTime);
    
    return {
      ...mlResult,
      duration: Date.now() - startTime
    };
  }

  // No healing found
  await recordAttempt(selector, null, pageUrl, testId, false, 0, 'none', Date.now() - startTime);
  
  return {
    success: false,
    error: 'No suitable healing selector found',
    duration: Date.now() - startTime
  };
}

/**
 * Check if we have a historical pattern for this selector
 */
async function checkHistoricalPattern(selector, pageUrl) {
  try {
    const key = pageUrl ? `${selector}#${pageUrl}` : selector;
    
    const result = await docClient.send(new GetCommand({
      TableName: PATTERNS_TABLE,
      Key: { patternKey: key }
    }));

    if (result.Item && result.Item.successRate >= 0.7) {
      console.log(`Found historical pattern: ${result.Item.healedSelector} (confidence: ${result.Item.confidence})`);
      
      // Update usage
      await docClient.send(new UpdateCommand({
        TableName: PATTERNS_TABLE,
        Key: { patternKey: key },
        UpdateExpression: 'SET usageCount = usageCount + :inc, lastUsed = :now',
        ExpressionAttributeValues: {
          ':inc': 1,
          ':now': Date.now()
        }
      }));

      return {
        healedSelector: result.Item.healedSelector,
        confidence: result.Item.confidence
      };
    }
  } catch (error) {
    console.error('Error checking historical pattern:', error);
  }
  
  return null;
}

/**
 * Perform ML-based healing using DOM snapshot analysis
 */
async function performMLHealing(originalSelector, domSnapshot, previousAttempts) {
  const candidates = [];

  // Priority 1: data-testid (most stable)
  if (domSnapshot.testIds && domSnapshot.testIds.length > 0) {
    for (const testId of domSnapshot.testIds) {
      if (!previousAttempts.includes(`[data-testid="${testId}"]`)) {
        candidates.push({
          selector: `[data-testid="${testId}"]`,
          confidence: 0.95,
          reason: 'data-testid attribute'
        });
      }
    }
  }

  // Priority 2: aria-label (accessible and stable)
  if (domSnapshot.ariaLabels && domSnapshot.ariaLabels.length > 0) {
    for (const label of domSnapshot.ariaLabels) {
      const selector = `[aria-label="${label}"]`;
      if (!previousAttempts.includes(selector)) {
        candidates.push({
          selector,
          confidence: 0.90,
          reason: 'aria-label attribute'
        });
      }
    }
  }

  // Priority 3: ID attributes
  if (domSnapshot.ids && domSnapshot.ids.length > 0) {
    for (const id of domSnapshot.ids) {
      const selector = `#${id}`;
      if (!previousAttempts.includes(selector) && id.length > 2) {
        candidates.push({
          selector,
          confidence: 0.85,
          reason: 'id attribute'
        });
      }
    }
  }

  // Priority 4: Class combinations (with element type if available)
  if (domSnapshot.classes && domSnapshot.classes.length > 0) {
    for (const className of domSnapshot.classes) {
      if (className.includes(' ')) continue; // Skip multi-class for now
      
      const baseSelector = `.${className}`;
      const selector = domSnapshot.elementType 
        ? `${domSnapshot.elementType}${baseSelector}`
        : baseSelector;
      
      if (!previousAttempts.includes(selector)) {
        candidates.push({
          selector,
          confidence: 0.75,
          reason: 'class attribute'
        });
      }
    }
  }

  // Priority 5: Text content (with element type)
  if (domSnapshot.textContents && domSnapshot.textContents.length > 0) {
    for (const text of domSnapshot.textContents) {
      if (text.length < 50 && text.length > 2) {
        const selector = domSnapshot.elementType
          ? `${domSnapshot.elementType}:has-text("${text}")`
          : `:has-text("${text}")`;
        
        if (!previousAttempts.includes(selector)) {
          candidates.push({
            selector,
            confidence: 0.70,
            reason: 'text content'
          });
        }
      }
    }
  }

  // Sort by confidence and return best
  candidates.sort((a, b) => b.confidence - a.confidence);

  if (candidates.length > 0) {
    const best = candidates[0];
    console.log(`ML healing found: ${best.selector} (${best.reason}, confidence: ${best.confidence})`);
    
    return {
      success: true,
      healedSelector: best.selector,
      confidence: best.confidence,
      method: 'ml-analysis',
      reason: best.reason,
      alternatives: candidates.slice(1, 4).map(c => c.selector)
    };
  }

  return { success: false };
}

/**
 * Store successful healing pattern
 */
async function storePattern(originalSelector, healedSelector, pageUrl, confidence) {
  try {
    const key = pageUrl ? `${originalSelector}#${pageUrl}` : originalSelector;
    
    await docClient.send(new PutCommand({
      TableName: PATTERNS_TABLE,
      Item: {
        patternKey: key,
        originalSelector,
        healedSelector,
        pageUrl: pageUrl || 'unknown',
        confidence,
        successRate: 1.0,
        usageCount: 1,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60) // 90 days
      }
    }));

    console.log(`Stored pattern: ${originalSelector} -> ${healedSelector}`);
  } catch (error) {
    console.error('Error storing pattern:', error);
  }
}

/**
 * Record healing attempt for analytics
 */
async function recordAttempt(originalSelector, healedSelector, pageUrl, testId, success, confidence, method, duration) {
  try {
    await docClient.send(new PutCommand({
      TableName: ATTEMPTS_TABLE,
      Item: {
        attemptId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        originalSelector,
        healedSelector,
        pageUrl: pageUrl || 'unknown',
        testId: testId || 'unknown',
        success,
        confidence,
        method,
        durationMs: duration,
        ttl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days
      }
    }));
  } catch (error) {
    console.error('Error recording attempt:', error);
  }
}