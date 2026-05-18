"""
Submit Tasks Lambda Function (Direct ECS Fargate)

Launches ECS Fargate tasks for each test container.
Replaces AWS Batch with direct ECS task invocation.
"""
import json
import os
import boto3
from datetime import datetime

ecs = boto3.client('ecs')

def lambda_handler(event, context):
    """
    Launch ECS Fargate tasks for JMeter tests.
    
    Input event:
    {
        "tests": [...],
        "runId": "execution-id"
    }
    
    Output:
    {
        "tasks": [
            {
                "testId": "api-load-test",
                "taskArns": ["arn:aws:ecs:...:task/123", ...],
                "numContainers": 3
            }
        ],
        "totalTasks": 3
    }
    """
    try:
        cluster = os.environ['ECS_CLUSTER']
        task_def_api = os.environ['TASK_DEF_ARN_API']
        task_def_browser = os.environ['TASK_DEF_ARN_BROWSER']
        config_bucket = os.environ['CONFIG_BUCKET']
        results_bucket = os.environ['RESULTS_BUCKET']
        subnets = os.environ['SUBNETS'].split(',')
        security_groups = os.environ['SECURITY_GROUPS'].split(',')
        signals_queue_url = os.environ['SIGNALS_QUEUE_URL']
        
        tests = event.get('tests', [])
        run_id = event.get('runId', 'unknown')
        
        print(f"🚀 Launching ECS Fargate tasks for {len(tests)} tests, runId: {run_id}")
        
        all_tasks = []
        total_task_count = 0
        
        for test in tests:
            test_id = test['testId']
            test_script = test['testScript']
            
            # Validate required fields from JMX parser
            if 'numOfContainers' not in test or test['numOfContainers'] == 0:
                error_msg = f"Test '{test_id}': numOfContainers is missing or 0. JMX parsing may have failed."
                print(f"❌ {error_msg}")
                print(f"   Test data: {json.dumps(test, indent=2)}")
                raise ValueError(error_msg)
            
            if 'testDetails' not in test:
                raise ValueError(f"Test '{test_id}': testDetails field is missing. JMX parsing may have failed.")
            
            num_containers = test['numOfContainers']
            threads = test['testDetails'].get('totalThreads', 0)
            # Get estimated duration for timeout protection
            estimated_duration = test['testDetails'].get('estimatedDurationSeconds', 3600)
            
            # Get data file from test config OR auto-detected from JMX
            # Priority: 1) dataFile from config, 2) dataFiles[0] from jmx-parser
            data_file_s3 = test.get('dataFile')  # From config (optional)
            
            # If not in config, check if jmx-parser auto-detected CSV files
            if not data_file_s3 and 'dataFiles' in test and test['dataFiles']:
                # Use first detected CSV file and convert to S3 path
                csv_filename = test['dataFiles'][0]  # e.g., "data/SSP_API_Test_Data_3.csv"
                data_file_s3 = f's3://{config_bucket}/{csv_filename}'
                print(f"  📄 Auto-detected CSV file: {csv_filename} → {data_file_s3}")
            
            jvm_args = test.get('jvmArgs', '-Xms512m -Xmx2g')
            jmeter_props = test.get('jmeterProperties', {})
            
            # Select task definition based on test type (k6-framework style)
            test_type = test.get('testType', 'api')  # Default to 'api' if not specified
            task_definition = task_def_browser if test_type == 'browser' else task_def_api
            
            print(f"  📊 Test {test_id}: type={test_type}, tasks={num_containers}")
            print(f"     Using task definition: {task_definition.split('/')[-1]}")
            
            task_arns = []
            
            # Calculate threads per container for parallel execution
            threads_per_container = threads // num_containers if num_containers > 0 else threads
            
            print(f"  📊 Thread Distribution:")
            print(f"     Total Threads: {threads}")
            print(f"     Containers: {num_containers}")
            print(f"     Threads per Container: {threads_per_container}")
            print(f"     Total (distributed): {threads_per_container * num_containers}")
            
            for container_idx in range(num_containers):
                # Build simple JMeter command - S3 downloads handled by entrypoint via env vars
                command = [
                    'jmeter',
                    '-n',  # Non-GUI mode
                    '-t', '/tmp/test.jmx',  # Local test plan (downloaded by entrypoint)
                    '-l', f'/tmp/results-{container_idx}.jtl',  # Results file
                    '-j', f'/tmp/jmeter-{container_idx}.log',  # JMeter log
                    # Distribution properties (for distributed test awareness)
                    '-JcontainerId', str(container_idx),
                    '-JtotalContainers', str(num_containers),
                    '-JthreadsPerContainer', str(threads_per_container),  # Divided thread count
                ]
                
                # Data file download handled by entrypoint via DATA_FILE_S3 env var
                # Partitioning handled by inject-jmx-partitioning.py using offset/increment
                
                # Add custom JMeter properties
                for prop_key, prop_value in jmeter_props.items():
                    command.extend([f'-J{prop_key}', str(prop_value)])
                
                # Task name prefix
                timestamp = datetime.utcnow().strftime('%Y%m%d-%H%M%S')
                task_family = f"jmeter-{test_id}-{container_idx}-{timestamp}"
                task_family = task_family.replace('_', '-')[:128]
                
                # Environment variables - pass S3 paths for entrypoint to download
                enable_sync = 'true' if num_containers > 1 else 'false'  # Enable sync for multi-container tests
                
                environment = [
                    {'name': 'TEST_ID', 'value': test_id},
                    {'name': 'CONTAINER_ID', 'value': str(container_idx)},
                    {'name': 'RUN_ID', 'value': run_id},
                    {'name': 'CONFIG_BUCKET', 'value': config_bucket},
                    {'name': 'RESULTS_BUCKET', 'value': results_bucket},
                    {'name': 'RESULTS_PREFIX', 'value': f'{run_id}/{test_id}'},
                    {'name': 'JVM_ARGS', 'value': jvm_args},
                    {'name': 'ENABLE_SYNC', 'value': enable_sync},
                    # S3 paths for test files (downloaded by entrypoint)
                    {'name': 'TEST_SCRIPT_S3', 'value': f's3://{config_bucket}/{test_script}'},
                    # Timeout protection - estimated duration for timeout calculation
                    {'name': 'ESTIMATED_DURATION_SECONDS', 'value': str(estimated_duration)},
                    # Thread distribution for parallel execution
                    {'name': 'TOTAL_THREADS', 'value': str(threads)},
                    {'name': 'NUM_CONTAINERS', 'value': str(num_containers)},
                    # SQS queue for container synchronization (replaces S3 signals/)
                    {'name': 'SIGNALS_QUEUE_URL', 'value': signals_queue_url},
                ]
                
                # Add Datadog configuration if enabled in test config
                # Add Datadog configuration if enabled in test config
                if test.get('enableDatadog', False):
                    environment.append({'name': 'ENABLE_DATADOG_METRICS', 'value': 'true'})
                    dd_site = test.get('datadogSite', 'datadoghq.com')
                    environment.append({'name': 'DD_SITE', 'value': dd_site})
                
                # Add data file S3 path if exists (entrypoint will download and partition using offset/increment)
                if data_file_s3:
                    environment.append({'name': 'DATA_FILE_S3', 'value': data_file_s3})
                
                # Launch ECS Fargate task
                try:
                    response = ecs.run_task(
                        cluster=cluster,
                        taskDefinition=task_definition,
                        launchType='FARGATE',
                        count=1,
                        networkConfiguration={
                            'awsvpcConfiguration': {
                                'subnets': subnets,
                                'securityGroups': security_groups,
                                'assignPublicIp': 'ENABLED'  # Required for ECR and S3 access
                            }
                        },
                        overrides={
                            'containerOverrides': [{
                                'name': 'jmeter',  # Must match container name in task definition
                                'command': command,
                                'environment': environment
                            }]
                        },
                        tags=[
                            {'key': 'testId', 'value': test_id},
                            {'key': 'runId', 'value': run_id},
                            {'key': 'containerId', 'value': str(container_idx)},
                            {'key': 'framework', 'value': 'jmeter-batch'},
                        ],
                        enableECSManagedTags=True,
                        propagateTags='TASK_DEFINITION'
                    )
                    
                    if response.get('tasks'):
                        task_arn = response['tasks'][0]['taskArn']
                        task_arns.append(task_arn)
                        total_task_count += 1
                        print(f"    ✓ Container {container_idx}: Task {task_arn.split('/')[-1]} launched")
                    else:
                        failure_reason = response.get('failures', [{}])[0].get('reason', 'Unknown')
                        print(f"    ❌ Container {container_idx}: Failed to launch - {failure_reason}")
                
                except Exception as e:
                    print(f"    ❌ Container {container_idx}: Failed to launch task - {str(e)}")
                    # Continue with other containers
                    continue
            
            all_tasks.append({
                'testId': test_id,
                'taskArns': task_arns,
                'numContainers': len(task_arns),
                'expectedContainers': num_containers,
                'totalThreads': threads,
                'threadsPerContainer': threads_per_container,
            })
        
        print(f"✅ Launched {total_task_count} ECS tasks across {len(all_tasks)} tests")
        
        return {
            'statusCode': 200,
            'tasks': all_tasks,
            'totalTasks': total_task_count,
            'runId': run_id,
            'timestamp': datetime.utcnow().isoformat(),
        }
        
    except Exception as e:
        print(f"❌ Unexpected error: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'error': 'InternalError',
            'message': f"Unexpected error: {str(e)}"
        }