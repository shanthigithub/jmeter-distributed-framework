#!/usr/bin/env python3
import boto3
import json
from datetime import datetime, timedelta

logs_client = boto3.client('logs')

# Get recent log events
log_group = '/aws/lambda/jmeter-ecs-submit-tasks'
start_time = int((datetime.now() - timedelta(hours=1)).timestamp() * 1000)

try:
    response = logs_client.filter_log_events(
        logGroupName=log_group,
        startTime=start_time,
        limit=100
    )
    
    print("=" * 80)
    print("SUBMIT-TASKS LAMBDA LOGS")
    print("=" * 80)
    
    for event in response['events']:
        message = event['message']
        if any(keyword in message for keyword in ['environment', 'TOTAL_THREADS', 'NUM_CONTAINERS', 'Submitting', 'Container']):
            timestamp = datetime.fromtimestamp(event['timestamp'] / 1000)
            print(f"\n[{timestamp}]")
            print(message)
            
except Exception as e:
    print(f"Error: {e}")