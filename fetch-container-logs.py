#!/usr/bin/env python3
import boto3
import sys

logs_client = boto3.client('logs', region_name='us-east-1')

log_group = '/jmeter/api'
log_stream = 'jmeter-api/jmeter/ed2183a0a3f44003a69f2c2338aac903'

print(f"Fetching logs from {log_stream}...")
print("="*80)

response = logs_client.get_log_events(
    logGroupName=log_group,
    logStreamName=log_stream,
    limit=100,
    startFromHead=False
)

events = response.get('events', [])
print(f"Found {len(events)} log entries:\n")

# Print last 50 lines
for event in events[-50:]:
    message = event['message'].rstrip()
    print(message)

print("\n" + "="*80)
print("Looking for key indicators...")
print("="*80)

# Look for specific patterns
for event in events:
    msg = event['message'].lower()
    if 'exit' in msg or 'complete' in msg or 'success' in msg or 'failed' in msg or 'error' in msg:
        print(f">>> {event['message'].rstrip()}")