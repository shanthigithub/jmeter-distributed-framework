#!/usr/bin/env python3
"""
Fetch latest CloudWatch logs for a specific log stream.
Usage: python3 fetch-latest-logs.py <log_group> <log_stream>
"""

import boto3
import sys
from datetime import datetime, timedelta

def fetch_logs(log_group, log_stream, limit=200):
    """Fetch latest logs from CloudWatch."""
    client = boto3.client('logs', region_name='us-east-1')
    
    try:
        # Get logs from last hour
        start_time = int((datetime.now() - timedelta(hours=1)).timestamp() * 1000)
        
        response = client.get_log_events(
            logGroupName=log_group,
            logStreamName=log_stream,
            startTime=start_time,
            limit=limit,
            startFromHead=False  # Get latest events first
        )
        
        events = response.get('events', [])
        
        if not events:
            print("No log events found")
            return
        
        print(f"=== CloudWatch Logs ===")
        print(f"Log Group: {log_group}")
        print(f"Log Stream: {log_stream}")
        print(f"Events: {len(events)}")
        print("=" * 80)
        print()
        
        for event in events:
            timestamp = datetime.fromtimestamp(event['timestamp'] / 1000)
            message = event['message']
            print(f"[{timestamp}] {message}")
        
    except Exception as e:
        print(f"Error fetching logs: {e}")
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 fetch-latest-logs.py <log_group> <log_stream>")
        print("\nExample:")
        print("  python3 fetch-latest-logs.py /jmeter/api 'jmeter-api/jmeter/99506844d4e14b6fab83b8b3b5fc35d0'")
        sys.exit(1)
    
    log_group = sys.argv[1]
    log_stream = sys.argv[2]
    
    fetch_logs(log_group, log_stream)