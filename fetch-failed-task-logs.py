#!/usr/bin/env python3
"""
Fetch CloudWatch logs for failed ECS tasks to diagnose errors.
Usage: python fetch-failed-task-logs.py <task-id-1> [task-id-2] ...
"""

import boto3
import sys
from datetime import datetime, timedelta

def fetch_task_logs(task_id, log_group='/aws/ecs/jmeter-framework', tail_lines=100):
    """Fetch CloudWatch logs for a specific ECS task."""
    
    logs = boto3.client('logs', region_name='us-east-1')
    
    # Log stream name format: jmeter/{task-id}
    log_stream_name = f"jmeter/{task_id}"
    
    print(f"\n{'='*80}")
    print(f"📋 TASK ID: {task_id}")
    print(f"📂 Log Group: {log_group}")
    print(f"📄 Log Stream: {log_stream_name}")
    print(f"{'='*80}\n")
    
    try:
        # Get log events (last N lines)
        response = logs.get_log_events(
            logGroupName=log_group,
            logStreamName=log_stream_name,
            limit=tail_lines,
            startFromHead=False  # Get most recent logs
        )
        
        events = response.get('events', [])
        
        if not events:
            print("⚠️  No log events found (container may have crashed before logging)")
            return
        
        print(f"📊 Found {len(events)} log entries (showing last {tail_lines}):\n")
        
        # Print all events
        for event in events:
            timestamp = datetime.fromtimestamp(event['timestamp'] / 1000.0)
            message = event['message'].rstrip()
            print(f"[{timestamp.strftime('%H:%M:%S')}] {message}")
        
        # Highlight errors
        print(f"\n{'─'*80}")
        print("🔍 ERROR ANALYSIS:")
        print(f"{'─'*80}\n")
        
        error_keywords = ['error', 'exception', 'failed', 'traceback', 'fatal']
        errors_found = []
        
        for event in events:
            message = event['message'].lower()
            if any(keyword in message for keyword in error_keywords):
                errors_found.append(event['message'].rstrip())
        
        if errors_found:
            print("❌ Errors detected:")
            for i, error in enumerate(errors_found, 1):
                print(f"\n  {i}. {error}")
        else:
            print("✅ No obvious errors in log messages")
            print("   (Check full log output above for issues)")
        
    except logs.exceptions.ResourceNotFoundException:
        print(f"❌ ERROR: Log stream not found!")
        print(f"   This could mean:")
        print(f"   - Container crashed before writing logs")
        print(f"   - Wrong task ID")
        print(f"   - Wrong log group name")
        
        # Try to list available log streams
        try:
            print(f"\n🔍 Available log streams in {log_group}:")
            streams_response = logs.describe_log_streams(
                logGroupName=log_group,
                orderBy='LastEventTime',
                descending=True,
                limit=5
            )
            for stream in streams_response.get('logStreams', []):
                print(f"   - {stream['logStreamName']}")
        except Exception as e:
            print(f"   Could not list streams: {e}")
    
    except Exception as e:
        print(f"❌ ERROR fetching logs: {e}")
        import traceback
        traceback.print_exc()

def main():
    if len(sys.argv) < 2:
        print("Usage: python fetch-failed-task-logs.py <task-id-1> [task-id-2] ...")
        print("\nExample:")
        print("  python fetch-failed-task-logs.py ae449131948b4dc6a5cf2e7c1c8c42b7")
        print("  python fetch-failed-task-logs.py ae449131... e06e1928...")
        sys.exit(1)
    
    task_ids = sys.argv[1:]
    
    print(f"🔍 Fetching logs for {len(task_ids)} task(s)...")
    
    for task_id in task_ids:
        # Clean task ID (remove any ARN prefix if provided)
        if '/' in task_id:
            task_id = task_id.split('/')[-1]
        
        fetch_task_logs(task_id)
    
    print(f"\n{'='*80}")
    print("✅ Log fetch complete!")
    print(f"{'='*80}\n")

if __name__ == '__main__':
    main()