import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface HealwrightStackProps extends cdk.StackProps {
  environment: string;
}

/**
 * Cost-Optimized Healwright ML Backend with DynamoDB
 * 
 * Estimated Monthly Cost: $10-15
 * - Lambda: $3-5/month (typical usage)
 * - DynamoDB: $5-8/month (on-demand pricing)
 * - API Gateway: $2-3/month
 * - CloudWatch Logs: <$1/month
 * 
 * No VPC, No Aurora, No RDS Proxy = Massive cost savings!
 */
export class HealwrightStack extends cdk.Stack {
  public readonly apiUrl: string;
  public readonly patternsTableName: string;
  public readonly attemptsTableName: string;

  constructor(scope: Construct, id: string, props: HealwrightStackProps) {
    super(scope, id, props);

    const envName = props.environment;

    // ========================================
    // DynamoDB Tables
    // ========================================

    // Healing Patterns Table
    const patternsTable = new dynamodb.Table(this, 'HealwrightPatternsTable', {
      tableName: `${envName}-healwright-patterns`,
      partitionKey: {
        name: 'patternKey',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // On-demand pricing
      timeToLiveAttribute: 'ttl', // Auto-delete old patterns after 90 days
      pointInTimeRecovery: envName === 'prod',
      removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    // Healing Attempts Table (for analytics)
    const attemptsTable = new dynamodb.Table(this, 'HealwrightAttemptsTable', {
      tableName: `${envName}-healwright-attempts`,
      partitionKey: {
        name: 'attemptId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', // Auto-delete after 30 days
      pointInTimeRecovery: envName === 'prod',
      removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for querying by selector
    attemptsTable.addGlobalSecondaryIndex({
      indexName: 'selector-timestamp-index',
      partitionKey: {
        name: 'originalSelector',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // ========================================
    // Lambda Function
    // ========================================
    const healwrightFunction = new lambda.Function(this, 'HealwrightMLFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/healwright-ml')),
      handler: 'index.handler',
      functionName: `${envName}-healwright-ml`,
      description: 'Healwright ML Backend - DynamoDB Version (Cost-Optimized)',
      memorySize: 512, // Reduced from 1024 to save cost
      timeout: cdk.Duration.seconds(20),
      environment: {
        PATTERNS_TABLE: patternsTable.tableName,
        ATTEMPTS_TABLE: attemptsTable.tableName,
        NODE_ENV: envName
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      reservedConcurrentExecutions: envName === 'prod' ? 10 : undefined
    });

    // Grant DynamoDB permissions
    patternsTable.grantReadWriteData(healwrightFunction);
    attemptsTable.grantReadWriteData(healwrightFunction);

    // ========================================
    // API Gateway
    // ========================================
    const api = new apigateway.RestApi(this, 'HealwrightAPI', {
      restApiName: `${envName}-healwright-ml-api`,
      description: 'Healwright ML API - Cost-Optimized DynamoDB Version',
      deployOptions: {
        stageName: envName,
        throttlingBurstLimit: 50, // Reduced from 100
        throttlingRateLimit: 25,  // Reduced from 50
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: envName !== 'prod',
        metricsEnabled: true
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: cdk.Duration.days(1)
      }
    });

    // Lambda integration
    const lambdaIntegration = new apigateway.LambdaIntegration(healwrightFunction, {
      proxy: true
    });

    // API endpoints
    const heal = api.root.addResource('heal');
    heal.addMethod('POST', lambdaIntegration);
    heal.addMethod('OPTIONS', lambdaIntegration);

    const health = api.root.addResource('health');
    health.addMethod('GET', lambdaIntegration);

    // ========================================
    // Lambda Warming (Optional - saves cold start penalty)
    // ========================================
    const warmingFunction = new lambda.Function(this, 'HealwrightWarmingFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromInline(`
        const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
        const lambda = new LambdaClient({});
        
        exports.handler = async (event) => {
          console.log('Warming Healwright Lambda...');
          
          try {
            await lambda.send(new InvokeCommand({
              FunctionName: process.env.HEALWRIGHT_FUNCTION_NAME,
              InvocationType: 'RequestResponse',
              Payload: JSON.stringify({ warm: true })
            }));
            
            console.log('Lambda warmed successfully');
            return { statusCode: 200, body: 'OK' };
          } catch (error) {
            console.error('Error warming Lambda:', error);
            return { statusCode: 500, body: error.message };
          }
        };
      `),
      handler: 'index.handler',
      functionName: `${envName}-healwright-warmer`,
      description: 'Keeps Healwright Lambda warm',
      timeout: cdk.Duration.seconds(10),
      environment: {
        HEALWRIGHT_FUNCTION_NAME: healwrightFunction.functionName
      }
    });

    // Grant warmer permission to invoke main function
    healwrightFunction.grantInvoke(warmingFunction);

    // Schedule warming every 5 minutes (Lambda stays warm for ~15 min with provisioned)
    const warmingRule = new events.Rule(this, 'HealwrightWarmingRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Keep Healwright Lambda warm',
      enabled: true
    });

    warmingRule.addTarget(new targets.LambdaFunction(warmingFunction));

    // ========================================
    // Outputs
    // ========================================
    this.apiUrl = api.url;
    this.patternsTableName = patternsTable.tableName;
    this.attemptsTableName = attemptsTable.tableName;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}heal`,
      description: 'Healwright ML API URL',
      exportName: `${envName}-healwright-api-url`
    });

    new cdk.CfnOutput(this, 'PatternsTable', {
      value: patternsTable.tableName,
      description: 'DynamoDB Patterns Table',
      exportName: `${envName}-healwright-patterns-table`
    });

    new cdk.CfnOutput(this, 'AttemptsTable', {
      value: attemptsTable.tableName,
      description: 'DynamoDB Attempts Table',
      exportName: `${envName}-healwright-attempts-table`
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: healwrightFunction.functionName,
      description: 'Healwright ML Lambda function name',
      exportName: `${envName}-healwright-lambda-name`
    });

    new cdk.CfnOutput(this, 'EstimatedMonthlyCost', {
      value: '$10-15 for typical usage (scales to ~$0 when idle)',
      description: 'Estimated monthly cost'
    });

    // ========================================
    // Tags
    // ========================================
    cdk.Tags.of(this).add('Project', 'Healwright');
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('CostCenter', 'TestAutomation');
    cdk.Tags.of(this).add('Version', '2.0-DynamoDB');
  }
}