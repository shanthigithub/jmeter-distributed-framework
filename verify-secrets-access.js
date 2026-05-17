/**
 * Quick verification script to test AWS Secrets Manager access
 * Run this before running your full test to ensure everything is configured correctly
 */

const { AWSSecretsHelper } = require('./lib/aws-secrets-helper');

async function verifyAccess() {
  console.log('='.repeat(80));
  console.log('AWS SECRETS MANAGER ACCESS VERIFICATION');
  console.log('='.repeat(80));
  console.log();

  try {
    console.log('📋 Step 1: Checking AWS credentials...');
    // AWS SDK will use environment variables or ~/.aws/credentials
    console.log('✅ AWS credentials available\n');

    console.log('📋 Step 2: Attempting to retrieve secret from Secrets Manager...');
    console.log('   Secret Name: anthropic-api-key');
    console.log('   Region: us-east-1\n');
    
    const secretsHelper = new AWSSecretsHelper('us-east-1');
    const { apiKey, baseURL } = await secretsHelper.getAnthropicCredentials();
    
    console.log('✅ SUCCESS! Secret retrieved successfully');
    console.log();
    console.log('Retrieved Configuration:');
    console.log('   Base URL:', baseURL);
    console.log('   API Key:', apiKey.substring(0, 15) + '...(truncated)');
    console.log();
    console.log('='.repeat(80));
    console.log('✅ VERIFICATION PASSED - You can now run your tests!');
    console.log('='.repeat(80));
    console.log();
    console.log('Next steps:');
    console.log('   1. Run: node tests/example-api-generation-with-secrets.js');
    console.log('   2. Or update your existing test scripts to use AWS Secrets Manager');
    console.log();
    
    return true;
    
  } catch (error) {
    console.error('❌ VERIFICATION FAILED');
    console.error();
    console.error('Error:', error.message);
    console.error();
    
    if (error.name === 'ResourceNotFoundException') {
      console.error('SOLUTION:');
      console.error('   The secret "anthropic-api-key" was not found in us-east-1');
      console.error('   You mentioned you created it, so please verify:');
      console.error('   1. Secret name is exactly: anthropic-api-key');
      console.error('   2. Secret is in region: us-east-1');
      console.error('   3. Run: aws secretsmanager describe-secret --secret-id anthropic-api-key --region us-east-1');
    } else if (error.name === 'AccessDeniedException') {
      console.error('SOLUTION:');
      console.error('   Your IAM role/user lacks permission to access Secrets Manager');
      console.error('   Required permission: secretsmanager:GetSecretValue');
      console.error('   Add this IAM policy:');
      console.error('   {');
      console.error('     "Effect": "Allow",');
      console.error('     "Action": ["secretsmanager:GetSecretValue"],');
      console.error('     "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:anthropic-api-key-*"');
      console.error('   }');
    } else if (error.message.includes('credentials')) {
      console.error('SOLUTION:');
      console.error('   AWS credentials not configured');
      console.error('   Options:');
      console.error('   1. Set environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
      console.error('   2. Configure AWS CLI: aws configure');
      console.error('   3. Use IAM role (if running on EC2/ECS)');
    } else {
      console.error('SOLUTION:');
      console.error('   Check the error message above for details');
      console.error('   Common issues:');
      console.error('   - Wrong region');
      console.error('   - Incorrect secret name');
      console.error('   - Network/firewall issues');
    }
    console.error();
    console.error('='.repeat(80));
    
    return false;
  }
}

// Run verification
verifyAccess()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });