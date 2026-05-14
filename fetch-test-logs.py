#!/usr/bin/env python3
import boto3
import sys

logs_client = boto3.client('logs', region_name='us-east-1')

log_group = '/jmeter/api'
log_stream = 'jmeter-api/jmeter/6e5061486d0348dc9c05ac18995f3aa7'

print(f"Fetching logs from {log_stream}...")
print("="*80)

try:
    response = logs_client.get_log_events(
        logGroupName=log_group,
        logStreamName=log_stream,
        limit=200,  # Get more logs
        startFromHead=False  # Get most recent logs
    )

    events = response.get('events', [])
    print(f"Found {len(events)} log entries\n")

    # Print ALL logs to see full execution trace
    for event in events:
        message = event['message'].rstrip()
        print(message)

except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)