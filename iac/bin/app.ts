#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { JMeterEcsStack } from '../lib/jmeter-ecs-stack';
import { HealwrightStack } from '../lib/healwright-stack';

const app = new cdk.App();

new JMeterEcsStack(app, 'JMeterEcsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Modern JMeter performance testing with Direct ECS Fargate - faster, simpler, more reliable',
  tags: {
    Project: 'jmeter-batch-framework',
    ManagedBy: 'CDK',
    CostCenter: 'performance-testing',
    Architecture: 'ECS-Fargate',
  },
});

// Healwright ML Backend - Cost-Optimized DynamoDB Version
new HealwrightStack(app, 'dev-healwright', {
  environment: 'dev',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Healwright ML Backend with DynamoDB - Cost-Optimized ($10-15/month)',
  tags: {
    Project: 'healwright',
    ManagedBy: 'CDK',
    CostCenter: 'test-automation',
    Architecture: 'Serverless',
  },
});

app.synth();
