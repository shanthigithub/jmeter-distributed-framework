/**
 * AWS Secrets Manager Helper
 * 
 * Retrieves API keys and credentials from AWS Secrets Manager
 * Used to securely access Anthropic API key for AI correlation analysis
 */

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

class AWSSecretsHelper {
  constructor(region = 'us-east-1') {
    this.client = new SecretsManagerClient({ region });
    this.cache = new Map();
  }

  /**
   * Get secret value from AWS Secrets Manager
   * @param {string} secretName - Name or ARN of the secret
   * @param {boolean} useCache - Whether to use cached value (default: true)
   * @returns {Promise<object>} - Secret value as parsed JSON object
   */
  async getSecret(secretName, useCache = true) {
    // Check cache first
    if (useCache && this.cache.has(secretName)) {
      console.log(`📦 Using cached secret: ${secretName}`);
      return this.cache.get(secretName);
    }

    try {
      console.log(`🔐 Retrieving secret from AWS Secrets Manager: ${secretName}`);
      
      const response = await this.client.send(
        new GetSecretValueCommand({
          SecretId: secretName,
        })
      );

      if (response.SecretString) {
        const secret = JSON.parse(response.SecretString);
        
        // Cache the secret
        this.cache.set(secretName, secret);
        
        console.log(`✅ Secret retrieved successfully`);
        return secret;
      }
      
      throw new Error('Secret not found or empty');
    } catch (error) {
      console.error(`❌ Failed to retrieve secret ${secretName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get Anthropic API credentials from Secrets Manager
   * Expects secret with structure: { "api_key": "sk-...", "base_url": "https://..." }
   * @returns {Promise<{apiKey: string, baseURL: string}>}
   */
  async getAnthropicCredentials() {
    const secret = await this.getSecret('anthropic-api-key');
    
    return {
      apiKey: secret.api_key || secret.apiKey || secret.key,
      baseURL: secret.base_url || secret.baseURL || 'https://litellm.anthropic.thomsonreuters.com'
    };
  }

  /**
   * Clear the cache (useful for key rotation)
   */
  clearCache() {
    this.cache.clear();
    console.log('🗑️  Secret cache cleared');
  }
}

module.exports = { AWSSecretsHelper };