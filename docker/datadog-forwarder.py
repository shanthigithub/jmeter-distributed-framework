#!/usr/bin/env python3
"""
JMeter JTL to Datadog Metrics Forwarder

Tails JMeter JTL file in real-time and sends metrics to Datadog.
Works with ANY JMX file - no Backend Listener needed!

Usage:
    python3 datadog-forwarder.py \
        --jtl-file /tmp/results.jtl \
        --dd-api-key <key> \
        --dd-site us5.datadoghq.com \
        --tags "test_id:my-test,run_id:123,container_id:1"
"""

import time
import sys
import os
import argparse
import signal
from collections import defaultdict, deque
from datadog import initialize, api
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[DATADOG-FORWARDER] %(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


class JTLForwarder:
    """Real-time JTL file forwarder to Datadog"""
    
    def __init__(self, jtl_file, dd_api_key, dd_site, tags, send_interval=10):
        self.jtl_file = jtl_file
        self.tags = [t.strip() for t in tags.split(',') if t.strip()]
        self.send_interval = send_interval
        self.running = True
        
        # Metrics buffer (store last N seconds of data)
        self.response_times = defaultdict(list)  # {endpoint: [elapsed, ...]}
        self.requests = []  # [(timestamp, endpoint, success, status_code), ...]
        self.last_send_time = time.time()
        
        # Initialize Datadog
        logger.info(f"Initializing Datadog API (site: {dd_site})")
        initialize(
            api_key=dd_api_key,
            api_host=f'https://api.{dd_site}'
        )
        logger.info(f"Datadog initialized with tags: {self.tags}")
        
        # Setup signal handlers
        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully"""
        logger.info(f"Received signal {signum}, shutting down gracefully...")
        self.running = False
    
    def wait_for_jtl_file(self, timeout=60):
        """Wait for JTL file to be created"""
        logger.info(f"Waiting for JTL file: {self.jtl_file}")
        start = time.time()
        
        while not os.path.exists(self.jtl_file):
            if time.time() - start > timeout:
                logger.error(f"Timeout waiting for JTL file after {timeout}s")
                return False
            time.sleep(0.5)
        
        logger.info("[SUCCESS] JTL file found, starting to tail...")
        return True
    
    def tail_jtl(self):
        """Tail JTL file and process lines in real-time"""
        if not self.wait_for_jtl_file():
            return
        
        with open(self.jtl_file, 'r') as f:
            # Skip header line
            header = f.readline()
            logger.info(f"JTL header: {header.strip()}")
            
            line_count = 0
            
            while self.running:
                line = f.readline()
                
                if line:
                    # Process line
                    if self.process_line(line):
                        line_count += 1
                        
                        # Log progress every 100 lines
                        if line_count % 100 == 0:
                            logger.info(f"Processed {line_count} requests")
                else:
                    # No new line, check if should send buffered metrics
                    if time.time() - self.last_send_time >= self.send_interval:
                        self.send_metrics()
                    
                    # Sleep briefly before checking for new lines
                    time.sleep(0.1)
            
            # Final send on shutdown
            logger.info("Sending final buffered metrics...")
            self.send_metrics()
            logger.info(f"[SUCCESS] Forwarder completed. Total requests processed: {line_count}")
    
    def process_line(self, line):
        """Parse JTL CSV line and buffer metrics"""
        try:
            # JTL CSV format (typical):
            # timestamp, elapsed, label, responseCode, responseMessage,
            # threadName, dataType, success, failureMessage, bytes, sentBytes,
            # grpThreads, allThreads, URL, Latency, IdleTime, Connect
            
            parts = line.strip().split(',')
            
            if len(parts) < 8:
                return False
            
            timestamp = int(parts[0]) / 1000.0  # Convert to seconds
            elapsed = int(parts[1])  # Response time in ms
            label = parts[2]  # Endpoint/sampler name
            response_code = parts[3]
            success = parts[7].lower() == 'true'
            
            # Buffer metrics
            self.response_times[label].append(elapsed)
            self.requests.append((timestamp, label, success, response_code))
            
            return True
            
        except Exception as e:
            logger.warning(f"Failed to parse line: {e} - Line: {line[:100]}")
            return False
    
    def send_metrics(self):
        """Calculate and send aggregated metrics to Datadog"""
        if not self.response_times and not self.requests:
            return
        
        now = time.time()
        metrics_sent = 0
        
        try:
            # 1. Response Time Metrics (per endpoint)
            for endpoint, times in self.response_times.items():
                if not times:
                    continue
                
                sorted_times = sorted(times)
                n = len(sorted_times)
                
                endpoint_tags = self.tags + [f'endpoint:{endpoint}']
                
                # Send percentiles
                metrics = {
                    'jmeter.response_time.avg': sum(times) / n,
                    'jmeter.response_time.min': sorted_times[0],
                    'jmeter.response_time.max': sorted_times[-1],
                    'jmeter.response_time.p50': sorted_times[int(n * 0.50)],
                    'jmeter.response_time.p95': sorted_times[int(n * 0.95)],
                    'jmeter.response_time.p99': sorted_times[int(n * 0.99)],
                }
                
                for metric_name, value in metrics.items():
                    api.Metric.send(
                        metric=metric_name,
                        points=[(now, value)],
                        tags=endpoint_tags
                    )
                    metrics_sent += 1
            
            # 2. Throughput and Error Rate (per endpoint)
            endpoint_stats = defaultdict(lambda: {'total': 0, 'errors': 0})
            
            for _, endpoint, success, response_code in self.requests:
                endpoint_stats[endpoint]['total'] += 1
                if not success:
                    endpoint_stats[endpoint]['errors'] += 1
            
            for endpoint, stats in endpoint_stats.items():
                endpoint_tags = self.tags + [f'endpoint:{endpoint}']
                
                # Throughput (requests in this interval / interval duration)
                throughput = stats['total'] / self.send_interval
                
                # Error rate (%)
                error_rate = (stats['errors'] / stats['total'] * 100) if stats['total'] > 0 else 0
                
                api.Metric.send(
                    metric='jmeter.throughput',
                    points=[(now, throughput)],
                    tags=endpoint_tags
                )
                
                api.Metric.send(
                    metric='jmeter.error_rate',
                    points=[(now, error_rate)],
                    tags=endpoint_tags
                )
                
                api.Metric.send(
                    metric='jmeter.requests.total',
                    points=[(now, stats['total'])],
                    tags=endpoint_tags,
                    type='count'
                )
                
                api.Metric.send(
                    metric='jmeter.requests.errors',
                    points=[(now, stats['errors'])],
                    tags=endpoint_tags,
                    type='count'
                )
                
                metrics_sent += 4
            
            logger.info(f"[METRICS] Sent {metrics_sent} metrics to Datadog")
            
        except Exception as e:
            logger.error(f"[ERROR] Error sending metrics to Datadog: {e}")
        
        finally:
            # Clear buffers
            self.response_times.clear()
            self.requests.clear()
            self.last_send_time = now


def main():
    parser = argparse.ArgumentParser(
        description='Forward JMeter JTL metrics to Datadog in real-time'
    )
    parser.add_argument('--jtl-file', required=True,
                        help='Path to JMeter JTL file')
    parser.add_argument('--dd-api-key', required=True,
                        help='Datadog API key')
    parser.add_argument('--dd-site', default='us5.datadoghq.com',
                        help='Datadog site (default: us5.datadoghq.com)')
    parser.add_argument('--tags', required=True,
                        help='Comma-separated tags (e.g., "test_id:foo,run_id:bar")')
    parser.add_argument('--send-interval', type=int, default=10,
                        help='Metrics send interval in seconds (default: 10)')
    
    args = parser.parse_args()
    
    logger.info("=" * 60)
    logger.info("JMeter to Datadog Metrics Forwarder")
    logger.info("=" * 60)
    logger.info(f"JTL File: {args.jtl_file}")
    logger.info(f"Datadog Site: {args.dd_site}")
    logger.info(f"Tags: {args.tags}")
    logger.info(f"Send Interval: {args.send_interval}s")
    logger.info("=" * 60)
    
    try:
        forwarder = JTLForwarder(
            jtl_file=args.jtl_file,
            dd_api_key=args.dd_api_key,
            dd_site=args.dd_site,
            tags=args.tags,
            send_interval=args.send_interval
        )
        
        forwarder.tail_jtl()
        
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"[ERROR] Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()