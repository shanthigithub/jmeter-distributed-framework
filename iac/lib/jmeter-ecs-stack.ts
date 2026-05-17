import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';
import { config } from '../environments/config';
import * as path from 'path';
import { JmxParserLambda } from './constructs/jmx-parser-lambda';

/**
 * JMeter ECS Fargate Framework Stack
 * 
 * Direct ECS Fargate execution - no AWS Batch complexity!
 * 
 * Key Features:
 * - Direct ECS Fargate task invocation (simpler, faster)
 * - No master-minion architecture (k6-style segments)
 * - S3-based dynamic loading (small images, fast deployments)
 * - Lambda orchestration (serverless, pay-per-use)
 * - Step Functions workflow (reliable, observable)
 * - Instant capacity (no SPOT wait times)
 * - Easier debugging (direct ECS logs)
 */
export class JMeterEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ═══════════════════════════════════════════════════════════════════════
    // S3 BUCKETS
    // ═══════════════════════════════════════════════════════════════════════

    const configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: config.configBucket,
      versioned: true,
      encryption: config.security.enableEncryption 
        ? s3.BucketEncryption.S3_MANAGED 
        : s3.BucketEncryption.UNENCRYPTED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      bucketName: config.resultsBucket,
      encryption: config.security.enableEncryption 
        ? s3.BucketEncryption.S3_MANAGED 
        : s3.BucketEncryption.UNENCRYPTED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{
        expiration: cdk.Duration.days(90),
        transitions: [{
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: cdk.Duration.days(30),
        }],
      }],
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SNS TOPIC FOR TEST SCRIPT VALIDATION NOTIFICATIONS
    // ═══════════════════════════════════════════════════════════════════════

    const validationTopic = new sns.Topic(this, 'TestValidationTopic', {
      displayName: 'Test Script Validation Notifications',
      topicName: 'test-script-validation',
    });

    // Subscribe team email
    // Note: You'll need to confirm the subscription via email after deployment
    validationTopic.addSubscription(
      new subscriptions.EmailSubscription('shanthireddy.kundur@gmail.com')
    );

    // ═══════════════════════════════════════════════════════════════════════
    // LAMBDA FUNCTION FOR TEST SCRIPT VALIDATION
    // ═══════════════════════════════════════════════════════════════════════

    const validateTestScriptFn = new lambda.Function(this, 'ValidateTestScript', {
      functionName: 'jmeter-validate-test-script',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'validate-test-script')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        SNS_TOPIC_ARN: validationTopic.topicArn,
      },
      description: 'Validates test scripts uploaded to S3 for security and best practices',
    });

    // Grant permissions to Lambda validator
    configBucket.grantReadWrite(validateTestScriptFn);
    validationTopic.grantPublish(validateTestScriptFn);

    // S3 trigger - validates JavaScript test scripts on upload
    configBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(validateTestScriptFn),
      { prefix: 'tests/', suffix: '.js' }
    );

    // ═══════════════════════════════════════════════════════════════════════
    // ECR REPOSITORY
    // ═══════════════════════════════════════════════════════════════════════

    const repository = new ecr.Repository(this, 'JMeterRepository', {
      repositoryName: config.ecrRepoName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        description: 'Keep only last 10 images',
        maxImageCount: 10,
      }],
    });

    // ═══════════════════════════════════════════════════════════════════════
    // VPC (Use Default VPC)
    // ═══════════════════════════════════════════════════════════════════════

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { 
      isDefault: true 
    });

    // Security Group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for JMeter ECS Fargate tasks',
      allowAllOutbound: true,  // Required for ECR, S3, and test endpoints
    });

    // ═══════════════════════════════════════════════════════════════════════
    // ECS CLUSTER
    // ═══════════════════════════════════════════════════════════════════════

    const cluster = new ecs.Cluster(this, 'JMeterCluster', {
      clusterName: 'jmeter-framework-cluster',
      vpc: vpc,
      containerInsights: true,  // Enable CloudWatch Container Insights
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IAM ROLES
    // ═══════════════════════════════════════════════════════════════════════

    // Task Role - assumed by containers running JMeter (access to S3)
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role for JMeter containers to access S3',
    });

    // Grant S3 permissions to task role
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ReadConfig',
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        configBucket.bucketArn,
        `${configBucket.bucketArn}/*`,
      ],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3WriteResults',
      actions: ['s3:PutObject'],
      resources: [`${resultsBucket.bucketArn}/*`],
    }));

    // Grant Secrets Manager access for Salesforce credentials
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerRead',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:k6-framework/salesforce-jwt-*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:anthropic-api-key-*`,
      ],
    }));

    // Task Execution Role - pulls ECR images, writes CloudWatch logs, reads secrets
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Import Datadog secret (if configured)
    let datadogSecret: secretsmanager.ISecret | undefined;
    if (config.monitoring.datadogSecretArn) {
      datadogSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'DatadogSecret',
        config.monitoring.datadogSecretArn
      );
      
      // Grant task execution role permission to read Datadog secret
      datadogSecret.grantRead(taskExecutionRole);
    }

    // Lambda Execution Role
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant Lambda permissions for S3
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3Access',
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [
        configBucket.bucketArn,
        `${configBucket.bucketArn}/*`,
        resultsBucket.bucketArn,
        `${resultsBucket.bucketArn}/*`,
      ],
    }));

    // Grant Lambda permissions for ECS
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsRunTask',
      actions: ['ecs:RunTask', 'ecs:TagResource'],
      resources: ['*'],  // Will be scoped after task definition creation
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsDescribeTasks',
      actions: ['ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:StopTask'],
      resources: ['*'],
    }));

    // Allow Lambda to pass roles to ECS tasks
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassRole',
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, taskExecutionRole.roleArn],
    }));

    // ═══════════════════════════════════════════════════════════════════════
    // ECS TASK DEFINITION
    // ═══════════════════════════════════════════════════════════════════════

    // CloudWatch Log Group for JMeter tasks
    const jmeterLogGroup = new logs.LogGroup(this, 'JMeterLogGroup', {
      logGroupName: '/ecs/jmeter',
      retention: config.logs.retentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TASK DEFINITIONS (API & BROWSER)
    // ═══════════════════════════════════════════════════════════════════════
    
    // Build container secrets configuration (shared by both task definitions)
    const containerSecrets: { [key: string]: ecs.Secret } = {};
    if (datadogSecret) {
      containerSecrets['DD_API_KEY'] = ecs.Secret.fromSecretsManager(datadogSecret);
    }

    // API Task Definition (2 vCPU / 4 GB) - For HTTP/REST API tests
    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: 'jmeter-api',
      cpu: config.ecs.apiTask.vcpus * 1024,  // 1 vCPU = 1024 units
      memoryLimitMiB: config.ecs.apiTask.memoryMiB,
      taskRole: taskRole,
      executionRole: taskExecutionRole,
    });

    // Create separate log group for API tasks
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/jmeter/api',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Get image tag from environment variable or use latest
    const imageTag = process.env.IMAGE_TAG || 'latest';
    
    apiTaskDefinition.addContainer('jmeter', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'jmeter-api',
        logGroup: apiLogGroup,
      }),
      environment: {
        CONFIG_BUCKET: config.configBucket,
        RESULTS_BUCKET: config.resultsBucket,
        AWS_REGION: this.region,
        TEST_TYPE: 'api',
      },
      secrets: Object.keys(containerSecrets).length > 0 ? containerSecrets : undefined,
      command: ['echo', 'JMeter API container - command will be set by Lambda'],
      stopTimeout: cdk.Duration.seconds(120), // Force stop after 2 minutes if container doesn't exit
    });

    // Browser Task Definition (4 vCPU / 8 GB) - For Selenium/JSR223 browser tests
    const browserTaskDefinition = new ecs.FargateTaskDefinition(this, 'BrowserTaskDefinition', {
      family: 'jmeter-browser',
      cpu: config.ecs.browserTask.vcpus * 1024,
      memoryLimitMiB: config.ecs.browserTask.memoryMiB,
      taskRole: taskRole,
      executionRole: taskExecutionRole,
    });

    // Create separate log group for browser tasks
    const browserLogGroup = new logs.LogGroup(this, 'BrowserLogGroup', {
      logGroupName: '/jmeter/browser',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    browserTaskDefinition.addContainer('jmeter', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'jmeter-browser',
        logGroup: browserLogGroup,
      }),
      environment: {
        CONFIG_BUCKET: config.configBucket,
        RESULTS_BUCKET: config.resultsBucket,
        AWS_REGION: this.region,
        TEST_TYPE: 'browser',
      },
      secrets: Object.keys(containerSecrets).length > 0 ? containerSecrets : undefined,
      command: ['echo', 'JMeter Browser container - command will be set by Lambda'],
      stopTimeout: cdk.Duration.seconds(120), // Force stop after 2 minutes if container doesn't exit
    });

    // ═══════════════════════════════════════════════════════════════════════
    // LAMBDA FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    // 1. Read Config - reads test configuration from S3
    const readConfigFn = new lambda.Function(this, 'ReadConfigFn', {
      functionName: 'jmeter-ecs-read-config',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'read-config')),
      role: lambdaRole,
      memorySize: config.lambda.memoryMB,
      timeout: cdk.Duration.seconds(config.lambda.timeoutSeconds.readConfig),
      environment: {
        CONFIG_BUCKET: config.configBucket,
      },
    });

    // 2. Submit Tasks - launches ECS Fargate tasks
    const submitTasksFn = new lambda.Function(this, 'SubmitTasksFn', {
      functionName: 'jmeter-ecs-submit-tasks',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'submit-tasks')),
      role: lambdaRole,
      memorySize: config.lambda.memoryMB,
      timeout: cdk.Duration.seconds(config.lambda.timeoutSeconds.submitTasks),
      environment: {
        ECS_CLUSTER: cluster.clusterName,
        TASK_DEF_ARN_API: apiTaskDefinition.taskDefinitionArn,
        TASK_DEF_ARN_BROWSER: browserTaskDefinition.taskDefinitionArn,
        CONFIG_BUCKET: config.configBucket,
        RESULTS_BUCKET: config.resultsBucket,
        SUBNETS: vpc.publicSubnets.map(s => s.subnetId).join(','),
        SECURITY_GROUPS: ecsSecurityGroup.securityGroupId,
      },
    });

    // 4. Check Tasks - checks ECS task status
    const checkTasksFn = new lambda.Function(this, 'CheckTasksFn', {
      functionName: 'jmeter-ecs-check-tasks',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'check-tasks')),
      role: lambdaRole,
      memorySize: config.lambda.memoryMB,
      timeout: cdk.Duration.seconds(config.lambda.timeoutSeconds.checkTasks),
      environment: {
        ECS_CLUSTER: cluster.clusterName,
      },
    });

    // 5. Wait For Ready - coordinates container synchronization
    const waitForReadyFn = new lambda.Function(this, 'WaitForReadyFn', {
      functionName: 'jmeter-ecs-wait-for-ready',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'wait-for-ready')),
      role: lambdaRole,
      memorySize: config.lambda.memoryMB,
      timeout: cdk.Duration.seconds(360), // 6 minutes (needs to wait for all containers)
      environment: {
        ECS_CLUSTER: cluster.clusterName,
        CONFIG_BUCKET: config.configBucket,
        MAX_WAIT_SECONDS: '300',  // 5 minutes max wait for all containers
        POLL_INTERVAL_SECONDS: '5',  // Check every 5 seconds
      },
    });

    // 6. Merge Results - aggregates results from all tasks
    const mergeResultsFn = new lambda.Function(this, 'MergeResultsFn', {
      functionName: 'jmeter-ecs-merge-results',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'merge-results')),
      role: lambdaRole,
      memorySize: config.lambda.memoryMB,
      timeout: cdk.Duration.seconds(config.lambda.timeoutSeconds.mergeResults),
      environment: {
        RESULTS_BUCKET: config.resultsBucket,
      },
    });

    // 7. JMX Parser - automatically extracts test configuration from JMX files
    const jmxParser = new JmxParserLambda(this, 'JmxParser', {
      configBucket: configBucket,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STEP FUNCTIONS WORKFLOW
    // ═══════════════════════════════════════════════════════════════════════

    // Task: Read Config
    const readConfigTask = new tasks.LambdaInvoke(this, 'ReadConfig', {
      lambdaFunction: readConfigFn,
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: '$.configResult',
    });

    // Task: Filter executable tests
    const filterTestsTask = new sfn.Pass(this, 'FilterExecutableTests', {
      parameters: {
        'tests.$': '$.configResult.Payload.testSuite[?(@.execute==true)]',
        'runId.$': '$$.Execution.Name',
      },
    });

    // Task: Parse JMX files to extract configuration
    const parseJmxTask = new sfn.Map(this, 'ParseJMX', {
      itemsPath: '$.tests',
      resultPath: '$.testsWithConfig',
      maxConcurrency: 5,
    }).iterator(
      new tasks.LambdaInvoke(this, 'ParseJMXFile', {
        lambdaFunction: jmxParser.function,
        payload: sfn.TaskInput.fromObject({
          'testScript.$': '$.testScript',
          'testId.$': '$.testId',
          'testType.$': '$.testType',
          'execute.$': '$.execute',
          'configBucket': config.configBucket,
          // Pass enableDatadog and datadogSite only if they exist (added by ReadConfig when user enables Datadog)
          'enableDatadog.$': '$.enableDatadog',
          'datadogSite.$': '$.datadogSite',
        }),
        resultSelector: {
          'Payload.$': '$.Payload',
        },
      }).addCatch(new sfn.Fail(this, 'ParseJMXFailed', {
        cause: 'Failed to parse JMX file',
        error: 'JMXParseError',
      }), {
        resultPath: '$.error',
      })
    );

    // Transform parsed results back to tests array
    const transformParsedTests = new sfn.Pass(this, 'TransformParsedTests', {
      parameters: {
        'tests.$': '$.testsWithConfig[*].Payload',
        'runId.$': '$.runId',
      },
    });

    // Task: Submit Tasks (ECS)
    const submitTasksTask = new tasks.LambdaInvoke(this, 'SubmitTasks', {
      lambdaFunction: submitTasksFn,
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: '$.tasksResult',
    });

    // Task: Wait For Ready - synchronize container startup (k6-style coordination)
    const waitForReadyTask = new sfn.Map(this, 'WaitForReady', {
      itemsPath: '$.tasksResult.Payload.tasks',
      resultPath: '$.syncResult',
      maxConcurrency: 5,
      parameters: {
        'test.$': '$$.Map.Item.Value',
        'runId.$': '$.tasksResult.Payload.runId',
      },
    }).iterator(
      new tasks.LambdaInvoke(this, 'WaitForReadyPerTest', {
        lambdaFunction: waitForReadyFn,
        payload: sfn.TaskInput.fromObject({
          'runId.$': '$.runId',
          'testId.$': '$.test.testId',
          'taskArns.$': '$.test.taskArns',
          'expectedTaskCount.$': '$.test.numContainers',
          'clusterArn': cluster.clusterArn,
          'configBucket': config.configBucket,
        }),
        resultSelector: {
          'Payload.$': '$.Payload',
        },
      })
    );

    // Task: Check Tasks
    const checkTasksTask = new tasks.LambdaInvoke(this, 'CheckTasks', {
      lambdaFunction: checkTasksFn,
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: '$.checkResult',
    });

    // Wait between task status checks
    const waitTask = new sfn.Wait(this, 'Wait', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(config.stepFunctions.waitBetweenChecks)),
    });

    // Task: Merge Results
    const mergeResultsTask = new tasks.LambdaInvoke(this, 'MergeResults', {
      lambdaFunction: mergeResultsFn,
      payload: sfn.TaskInput.fromObject({
        'tasks.$': '$.tasksResult.Payload.tasks',
        'runId.$': '$.runId',
      }),
      resultPath: '$.mergeResult',
    });

    // Success state
    const successState = new sfn.Succeed(this, 'Success');

    // Choice: Check if tasks are done
    const tasksDoneChoice = new sfn.Choice(this, 'TasksDone?')
      .when(
        sfn.Condition.booleanEquals('$.checkResult.Payload.allTasksComplete', true),
        mergeResultsTask
      )
      .when(
        sfn.Condition.booleanEquals('$.checkResult.Payload.anyTasksFailed', true),
        new sfn.Fail(this, 'TasksFailed', {
          cause: 'One or more ECS tasks failed',
          error: 'EcsTasksFailure',
        })
      )
      .otherwise(waitTask);

    // Connect states
    waitTask.next(checkTasksTask);
    checkTasksTask.next(tasksDoneChoice);
    mergeResultsTask.next(successState);

    // Define workflow
    const definition = readConfigTask
      .next(filterTestsTask)
      .next(parseJmxTask)
      .next(transformParsedTests)
      // REMOVED: partitionDataTask - CSV partitioning now done via offset/increment in entrypoint
      // REMOVED: transformPartitionedData - no longer needed
      .next(submitTasksTask)
      .next(waitForReadyTask)  // Synchronize containers before starting test
      .next(checkTasksTask);

    // Create State Machine
    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: 'jmeter-ecs-workflow',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(config.stepFunctions.timeoutMinutes),
      tracingEnabled: true,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // OUTPUTS
    // ═══════════════════════════════════════════════════════════════════════

    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: configBucket.bucketName,
      description: 'S3 bucket for test scripts and data',
      exportName: 'JMeterEcs-ConfigBucket',
    });

    new cdk.CfnOutput(this, 'ResultsBucketName', {
      value: resultsBucket.bucketName,
      description: 'S3 bucket for test results',
      exportName: 'JMeterEcs-ResultsBucket',
    });

    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: repository.repositoryUri,
      description: 'ECR repository URI for JMeter Docker image',
      exportName: 'JMeterEcs-RepositoryUri',
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Step Functions state machine ARN (use in GitHub Actions)',
      exportName: 'JMeterEcs-StateMachineArn',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name',
      exportName: 'JMeterEcs-ClusterName',
    });

    new cdk.CfnOutput(this, 'ApiTaskDefinitionArn', {
      value: apiTaskDefinition.taskDefinitionArn,
      description: 'ECS API task definition ARN (2 vCPU / 4 GB)',
      exportName: 'JMeterEcs-ApiTaskDefinitionArn',
    });

    new cdk.CfnOutput(this, 'BrowserTaskDefinitionArn', {
      value: browserTaskDefinition.taskDefinitionArn,
      description: 'ECS Browser task definition ARN (4 vCPU / 8 GB)',
      exportName: 'JMeterEcs-BrowserTaskDefinitionArn',
    });

    new cdk.CfnOutput(this, 'ValidationTopicArn', {
      value: validationTopic.topicArn,
      description: 'SNS topic for test script validation notifications',
      exportName: 'JMeterEcs-ValidationTopicArn',
    });

    new cdk.CfnOutput(this, 'ValidatorFunctionName', {
      value: validateTestScriptFn.functionName,
      description: 'Lambda function that validates test scripts',
      exportName: 'JMeterEcs-ValidatorFunctionName',
    });
  }
}
