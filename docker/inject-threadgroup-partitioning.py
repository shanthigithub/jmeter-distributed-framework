#!/usr/bin/env python3
"""
Inject ThreadGroup partitioning into JMX file
Divides threads among containers so each runs a subset of users
"""

import xml.etree.ElementTree as ET
import sys
import os
import math

def inject_threadgroup_partitioning(jmx_file, container_id, total_containers):
    """
    Partition ThreadGroup threads among containers.
    
    Args:
        jmx_file: Path to JMX file
        container_id: Container ID (0-based)
        total_containers: Total number of containers
    
    Example:
        200 threads, 4 containers:
        - Container 0: threads 1-50 (50 threads)
        - Container 1: threads 51-100 (50 threads)
        - Container 2: threads 101-150 (50 threads)
        - Container 3: threads 151-200 (50 threads)
    """
    print(f"\n{'='*70}")
    print(f"ThreadGroup Partitioning Injection")
    print(f"{'='*70}")
    print(f"Container: {container_id + 1} of {total_containers}")
    print(f"JMX File: {jmx_file}")
    print(f"{'='*70}\n")
    
    # Parse JMX file
    try:
        tree = ET.parse(jmx_file)
        root = tree.getroot()
    except Exception as e:
        print(f"[ERROR] Error parsing JMX file: {e}")
        sys.exit(1)
    
    # Find all ThreadGroup elements
    thread_groups = []
    thread_group_classes = [
        'ThreadGroup',
        'SetupThreadGroup',
        'PostThreadGroup',
        'com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup'
    ]
    
    for tg_class in thread_group_classes:
        for elem in root.iter():
            if elem.get('testclass') == tg_class:
                thread_groups.append(elem)
    
    if not thread_groups:
        print("[INFO] No ThreadGroup elements found in JMX file")
        print(f"{'='*70}\n")
        return
    
    print(f"[INFO] Found {len(thread_groups)} ThreadGroup element(s)\n")
    
    modified_count = 0
    for i, thread_group in enumerate(thread_groups, 1):
        tg_name = thread_group.get('testname', f'ThreadGroup_{i}')
        
        # Get current thread count
        original_threads = get_thread_count(thread_group)
        
        if original_threads <= 0:
            print(f"  [WARNING] {tg_name}: Invalid thread count ({original_threads}), skipping")
            continue
        
        # Calculate threads for this container
        threads_per_container = math.ceil(original_threads / total_containers)
        
        # Calculate start and end for this container
        start_thread = container_id * threads_per_container
        end_thread = min(start_thread + threads_per_container, original_threads)
        threads_for_this_container = end_thread - start_thread
        
        if threads_for_this_container <= 0:
            print(f"  [SKIP] {tg_name}: No threads assigned to container {container_id + 1}")
            threads_for_this_container = 0
        
        # Update thread count
        set_thread_count(thread_group, threads_for_this_container)
        
        print(f"  [SUCCESS] {tg_name}:")
        print(f"     Original threads: {original_threads}")
        print(f"     Threads per container: ~{threads_per_container}")
        print(f"     This container ({container_id + 1}): {threads_for_this_container} threads")
        print(f"     Thread range: {start_thread + 1}-{end_thread}")
        print()
        
        modified_count += 1
    
    # Save modified JMX
    try:
        tree.write(jmx_file, encoding='utf-8', xml_declaration=True)
        print(f"[SUCCESS] Modified {modified_count} ThreadGroup(s)")
        print(f"[SAVE] Saved to: {jmx_file}")
    except Exception as e:
        print(f"[ERROR] Error saving JMX file: {e}")
        sys.exit(1)
    
    print(f"{'='*70}\n")


def get_thread_count(thread_group):
    """Extract thread count from ThreadGroup element."""
    
    # Try intProp first (JMeter 5.x)
    for elem in thread_group.findall('./intProp'):
        if elem.get('name') == 'ThreadGroup.num_threads':
            try:
                return int(elem.text or '0')
            except ValueError:
                pass
    
    # Try stringProp as fallback
    for elem in thread_group.findall('./stringProp'):
        if elem.get('name') == 'ThreadGroup.num_threads':
            try:
                return int(elem.text or '0')
            except ValueError:
                pass
    
    return 0


def set_thread_count(thread_group, new_count):
    """Set thread count in ThreadGroup element."""
    
    # Try to update intProp first
    for elem in thread_group.findall('./intProp'):
        if elem.get('name') == 'ThreadGroup.num_threads':
            elem.text = str(new_count)
            return
    
    # Try to update stringProp
    for elem in thread_group.findall('./stringProp'):
        if elem.get('name') == 'ThreadGroup.num_threads':
            elem.text = str(new_count)
            return
    
    # If not found, create new intProp
    new_elem = ET.SubElement(thread_group, 'intProp')
    new_elem.set('name', 'ThreadGroup.num_threads')
    new_elem.text = str(new_count)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: inject-threadgroup-partitioning.py <jmx_file> <container_id> <total_containers>")
        sys.exit(1)
    
    jmx_file = sys.argv[1]
    container_id = int(sys.argv[2])
    total_containers = int(sys.argv[3])
    
    inject_threadgroup_partitioning(jmx_file, container_id, total_containers)