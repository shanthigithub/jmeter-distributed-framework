#!/usr/bin/env python3
"""
Copado Deployment Monitor (During Test Execution)
==================================================

Monitors Copado for NEW deployments while performance test is running.
If a new deployment is detected, triggers the stop-test workflow to gracefully
terminate the running test.

Usage:
    python monitor-copado-during-test.py \
        --api-url <url> \
        --api-token <token> \
        --environment <env> \
        --execution-arn <arn> \
        --github-token <token> \
        --repo <owner/repo>

Exit Codes:
    0 - No deployment detected (test completed normally)
    1 - Deployment detected, stop-test triggered
    2 - Error occurred
"""

import sys
import time
import json
import argparse
from datetime import datetime
import requests
from typing import Dict, Optional


class CopadoMonitor:
    """Monitors Copado for new deployments during test execution."""
    
    def __init__(self, copado_config: Dict, github_config: Dict, monitor_config: Dict):
        self.copado_api_url = copado_config['api_url'].rstrip('/')
        self.copado_token = copado_config['api_token']
        self.environment = copado_config['environment']
        
        self.github_token = github_config['token']
        self.repo = github_config['repo']  # format: owner/repo
        
        self.execution_arn = monitor_config['execution_arn']
        self.poll_interval_minutes = monitor_config['poll_interval_minutes']
        self.max_monitor_duration_minutes = monitor_config.get('max_duration_minutes', 300)
        
        self.copado_session = requests.Session()
        self.copado_session.headers.update(self._get_copado_headers())
        
        self.github_session = requests.Session()
        self.github_session.headers.update(self._get_github_headers())
    
    def _get_copado_headers(self) -> Dict[str, str]:
        """
        Get authentication headers for Copado API.
        
        TODO: UPDATE THIS METHOD based on actual Copado authentication
        """
        return {
            "Authorization": f"Bearer {self.copado_token}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
    
    def _get_github_headers(self) -> Dict[str, str]:
        """Get authentication headers for GitHub API."""
        return {
            "Authorization": f"token {self.github_token}",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
        }
    
    def check_for_new_deployment(self) -> bool:
        """
        Check if a NEW deployment has started in Copado.
        
        Returns:
            True if deployment detected, False otherwise
        
        TODO: REPLACE THIS METHOD with actual Copado API call
        """
        try:
            # PLACEHOLDER: Replace with actual Copado API endpoint
            endpoint = f"{self.copado_api_url}/v1/deployments/status"
            params = {
                "environment": self.environment,
                "status": "in_progress"
            }
            
            # TODO: Uncomment when ready
            # response = self.copado_session.get(endpoint, params=params, timeout=30)
            # response.raise_for_status()
            # data = response.json()
            
            # PLACEHOLDER: Returns False (no deployment) for testing
            data = {
                "deployments": [],
                "status": "idle"
            }
            
            # TODO: UPDATE based on actual API response
            if data.get("deployments"):
                deployment = data["deployments"][0]
                print(f"⚠️  NEW DEPLOYMENT DETECTED!")
                print(f"   Name: {deployment.get('name', 'Unknown')}")
                print(f"   ID: {deployment.get('id', 'Unknown')}")
                print(f"   Started: {deployment.get('started_at', 'Unknown')}")
                return True
            
            return False
            
        except requests.exceptions.RequestException as e:
            print(f"⚠️  Copado API check failed: {e}")
            # On error, assume no deployment (fail-safe)
            return False
    
    def trigger_stop_test_workflow(self) -> bool:
        """
        Trigger the stop-test GitHub Actions workflow.
        
        Returns:
            True if workflow triggered successfully
        """
        try:
            owner, repo = self.repo.split('/')
            url = f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/stop-test.yml/dispatches"
            
            payload = {
                "ref": "main",  # or "master" - adjust as needed
                "inputs": {
                    "execution_arn": self.execution_arn,
                    "reason": "Copado deployment detected during test execution"
                }
            }
            
            print(f"🛑 Triggering stop-test workflow...")
            print(f"   Workflow: {url}")
            print(f"   Execution ARN: {self.execution_arn}")
            
            response = self.github_session.post(url, json=payload, timeout=30)
            response.raise_for_status()
            
            print(f"✅ Stop-test workflow triggered successfully")
            return True
            
        except requests.exceptions.RequestException as e:
            print(f"❌ Failed to trigger stop-test workflow: {e}")
            return False
    
    def monitor(self) -> int:
        """
        Main monitoring loop.
        
        Returns:
            Exit code
        """
        print("=" * 70)
        print("Copado Deployment Monitor - Active Test Protection")
        print("=" * 70)
        print(f"Start Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"Environment: {self.environment}")
        print(f"Execution ARN: {self.execution_arn}")
        print(f"Poll Interval: {self.poll_interval_minutes} minutes")
        print(f"Max Duration: {self.max_monitor_duration_minutes} minutes")
        print("=" * 70)
        
        start_time = datetime.now()
        poll_count = 0
        
        try:
            while True:
                poll_count += 1
                elapsed_minutes = (datetime.now() - start_time).total_seconds() / 60
                
                print(f"\n🔍 Monitor Check #{poll_count} (elapsed: {elapsed_minutes:.1f} min)")
                print(f"   Time: {datetime.now().strftime('%H:%M:%S')}")
                
                # Check if deployment started
                if self.check_for_new_deployment():
                    print(f"\n⚠️  DEPLOYMENT DETECTED - STOPPING TEST")
                    
                    if self.trigger_stop_test_workflow():
                        print(f"\n✅ Stop-test workflow triggered successfully")
                        print(f"   Test will be gracefully terminated")
                        return 1
                    else:
                        print(f"\n⚠️  Failed to trigger stop-test workflow")
                        print(f"   Manual intervention may be required")
                        return 2
                
                print(f"   ✅ No deployment detected - test continues safely")
                
                # Check if we've exceeded max monitoring duration
                if elapsed_minutes >= self.max_monitor_duration_minutes:
                    print(f"\n⏰ Max monitoring duration reached ({self.max_monitor_duration_minutes} min)")
                    print(f"   Assuming test completed - exiting monitor")
                    return 0
                
                # Sleep until next check
                print(f"   💤 Sleeping {self.poll_interval_minutes} minutes until next check...")
                time.sleep(self.poll_interval_minutes * 60)
                
        except KeyboardInterrupt:
            print(f"\n⚠️  Monitor interrupted by user")
            return 0
        except Exception as e:
            print(f"\n❌ Monitor error: {e}")
            import traceback
            traceback.print_exc()
            return 2


def main():
    parser = argparse.ArgumentParser(
        description='Monitor Copado for new deployments during test execution'
    )
    
    # Copado configuration
    parser.add_argument('--api-url', required=True, help='Copado API base URL')
    parser.add_argument('--api-token', required=True, help='Copado API token')
    parser.add_argument('--environment', required=True, help='Environment to monitor')
    
    # GitHub configuration
    parser.add_argument('--github-token', required=True, help='GitHub token for triggering workflows')
    parser.add_argument('--repo', required=True, help='GitHub repository (owner/repo)')
    
    # Monitoring configuration
    parser.add_argument('--execution-arn', required=True, help='Step Functions execution ARN')
    parser.add_argument(
        '--poll-interval-minutes',
        type=int,
        default=10,
        help='Minutes between deployment checks (default: 10)'
    )
    parser.add_argument(
        '--max-duration-minutes',
        type=int,
        default=300,
        help='Max monitoring duration in minutes (default: 300 / 5 hours)'
    )
    
    args = parser.parse_args()
    
    copado_config = {
        'api_url': args.api_url,
        'api_token': args.api_token,
        'environment': args.environment
    }
    
    github_config = {
        'token': args.github_token,
        'repo': args.repo
    }
    
    monitor_config = {
        'execution_arn': args.execution_arn,
        'poll_interval_minutes': args.poll_interval_minutes,
        'max_duration_minutes': args.max_duration_minutes
    }
    
    monitor = CopadoMonitor(copado_config, github_config, monitor_config)
    exit_code = monitor.monitor()
    sys.exit(exit_code)


if __name__ == '__main__':
    main()