"""
Lambda function to wait for all ECS tasks to be in RUNNING state,
then signal containers to start test execution simultaneously.

This implements k6-style barrier coordination for distributed load tests.
"""

import json
import boto3
import os
import time
from datetime import datetime

ecs = boto3.client('ecs')
sqs = boto3.client('sqs')

def handler(event, context):
    """
    Wait for all ECS tasks to reach RUNNING state, then write START signal to S3.
    
    Expected event format:
    {
        "runId": "test-20260425-131003-18",
        "testId": "dcp-api-test",
        "clusterArn": "arn:aws:ecs:...",
        "taskArns": ["arn:aws:ecs:...", "arn:aws:ecs:..."],
        "expectedTaskCount": 5,
        "configBucket": "jmeter-framework-config"
    }
    """
    
    run_id = event['runId']
    test_id = event['testId']
    cluster_arn = event['clusterArn']
    task_arns = event['taskArns']
    expected_count = event['expectedTaskCount']
    config_bucket = event['configBucket']
    
    max_wait_time = int(os.environ.get('MAX_WAIT_SECONDS', '300'))  # 5 minutes default
    poll_interval = int(os.environ.get('POLL_INTERVAL_SECONDS', '5'))
    
    start_time = time.time()
    
    print(f"[COORDINATOR] Waiting for {expected_count} tasks to be RUNNING")
    print(f"[COORDINATOR] Run ID: {run_id}")
    print(f"[COORDINATOR] Test ID: {test_id}")
    print(f"[COORDINATOR] Max wait time: {max_wait_time}s")
    print(f"[COORDINATOR] Poll interval: {poll_interval}s")
    
    attempt = 0
    while True:
        attempt += 1
        elapsed = time.time() - start_time
        
        if elapsed > max_wait_time:
            error_msg = f"Timeout waiting for tasks to be RUNNING after {elapsed:.1f}s"
            print(f"❌ [ERROR] {error_msg}")
            
            # Get current task states for debugging
            try:
                response = ecs.describe_tasks(cluster=cluster_arn, tasks=task_arns)
                task_states = {}
                for task in response['tasks']:
                    task_id = task['taskArn'].split('/')[-1]
                    task_states[task_id] = task['lastStatus']
                
                print(f"[DEBUG] Final task states: {json.dumps(task_states, indent=2)}")
            except Exception as e:
                print(f"[WARNING] Could not get task states: {e}")
            
            raise TimeoutError(error_msg)
        
        # Describe all tasks
        try:
            response = ecs.describe_tasks(
                cluster=cluster_arn,
                tasks=task_arns
            )
        except Exception as e:
            print(f"❌ [ERROR] Failed to describe tasks: {e}")
            raise
        
        if not response['tasks']:
            raise ValueError(f"No tasks found for ARNs: {task_arns}")
        
        # Check task status
        running_tasks = []
        pending_tasks = []
        stopped_tasks = []
        
        for task in response['tasks']:
            task_id = task['taskArn'].split('/')[-1]
            status = task['lastStatus']
            
            if status == 'RUNNING':
                running_tasks.append(task_id)
            elif status in ['PENDING', 'PROVISIONING', 'ACTIVATING']:
                pending_tasks.append(task_id)
            elif status in ['DEPROVISIONING', 'STOPPING', 'DEACTIVATING', 'STOPPED']:
                stopped_tasks.append(task_id)
                # Get stop reason if available
                stop_reason = task.get('stoppedReason', 'Unknown')
                containers = task.get('containers', [])
                for container in containers:
                    if container.get('exitCode'):
                        print(f"❌ [ERROR] Task {task_id} stopped: {stop_reason}, Exit code: {container['exitCode']}")
        
        running_count = len(running_tasks)
        pending_count = len(pending_tasks)
        stopped_count = len(stopped_tasks)
        
        print(f"[ATTEMPT {attempt}] Status: {running_count}/{expected_count} RUNNING, "
              f"{pending_count} PENDING, {stopped_count} STOPPED (elapsed: {elapsed:.1f}s)")
        
        # If any tasks stopped, fail immediately
        if stopped_tasks:
            error_msg = f"{stopped_count} task(s) stopped prematurely: {stopped_tasks}"
            print(f"❌ [ERROR] {error_msg}")
            raise RuntimeError(error_msg)
        
        # Check if all expected tasks are running
        if running_count == expected_count:
            print(f"✅ [SUCCESS] All {expected_count} tasks are RUNNING!")
            break
        
        # Wait before next poll
        print(f"   ⏳ Waiting {poll_interval}s before next check...")
        time.sleep(poll_interval)
    
    # All tasks are RUNNING - send START signal via SQS
    queue_url = os.environ['SIGNALS_QUEUE_URL']
    
    signal_data = {
        'runId': run_id,
        'testId': test_id,
        'timestamp': datetime.utcnow().isoformat(),
        'taskCount': expected_count,
        'taskArns': task_arns,
        'message': 'START'  # Simple command for containers to begin
    }
    
    try:
        print(f"[SIGNAL] Sending START signal to SQS queue: {queue_url}")
        print(f"[SIGNAL] Message group ID: {run_id}_{test_id}")
        
        response = sqs.send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps(signal_data),
            MessageGroupId=f"{run_id}_{test_id}",  # FIFO: groups messages by test
            MessageDeduplicationId=f"{run_id}_{test_id}_START_{int(time.time() * 1000)}"  # Unique ID
        )
        
        print(f"✅ [SIGNAL] START signal sent successfully")
        print(f"   Message ID: {response['MessageId']}")
        print(f"   Sequence Number: {response.get('SequenceNumber', 'N/A')}")
    except Exception as e:
        print(f"❌ [ERROR] Failed to send START signal to SQS: {e}")
        raise
    
    return {
        'statusCode': 200,
        'body': {
            'runId': run_id,
            'testId': test_id,
            'taskCount': expected_count,
            'signalMethod': 'SQS',
            'queueUrl': queue_url,
            'messageId': response['MessageId'],
            'waitTimeSeconds': round(time.time() - start_time, 1),
            'message': 'All tasks synchronized and ready to start'
        }
    }
