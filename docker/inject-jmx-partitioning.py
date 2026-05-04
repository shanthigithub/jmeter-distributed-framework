#!/usr/bin/env python3
"""
Inject CSV Data partitioning properties into JMX file
Automatically adds offset and increment properties to all CSV Data Set configs
"""

import xml.etree.ElementTree as ET
import sys
import os

def inject_partitioning(jmx_file, container_id, total_containers):
    """
    Inject offset/increment properties into all CSV Data Set configs
    
    Args:
        jmx_file: Path to JMX file
        container_id: Container ID (0-based)
        total_containers: Total number of containers
    """
    print(f"\n{'='*70}")
    print(f"CSV Data Partitioning Injection")
    print(f"{'='*70}")
    print(f"Container: {container_id} of {total_containers}")
    print(f"JMX File: {jmx_file}")
    print(f"{'='*70}\n")
    
    # Parse JMX file
    try:
        tree = ET.parse(jmx_file)
        root = tree.getroot()
    except Exception as e:
        print(f"[ERROR] Error parsing JMX file: {e}")
        sys.exit(1)
    
    # Find all CSVDataSet elements (try with and without namespace)
    csv_configs = []
    for elem in root.iter():
        if elem.get('testclass') == 'CSVDataSet':
            csv_configs.append(elem)
    
    if not csv_configs:
        print("[INFO] No CSV Data Set configs found in JMX file")
        print(f"{'='*70}\n")
        return
    
    print(f"[INFO] Found {len(csv_configs)} CSV Data Set config(s)\n")
    
    modified_count = 0
    for i, csv_config in enumerate(csv_configs, 1):
        csv_name = csv_config.get('testname', f'CSV_{i}')
        
        # Get filename if available
        filename_elem = csv_config.find('.//stringProp[@name="filename"]')
        filename = filename_elem.text if filename_elem is not None else 'N/A'
        
        # Remove existing offset/increment properties (if any)
        for prop in ['offset', 'increment']:
            for elem in csv_config.findall(f'.//stringProp[@name="{prop}"]'):
                csv_config.remove(elem)
        
        # Add offset property
        offset = ET.SubElement(csv_config, 'stringProp')
        offset.set('name', 'offset')
        offset.text = str(container_id)
        
        # Add increment property  
        increment = ET.SubElement(csv_config, 'stringProp')
        increment.set('name', 'increment')
        increment.text = str(total_containers)
        
        print(f"[PARTITION] {csv_name}")
        print(f"   File: {filename}")
        print(f"   → offset={container_id}, increment={total_containers}")
        print(f"   (Container {container_id} will read rows {container_id}, {container_id + total_containers}, {container_id + 2*total_containers}, ...)\n")
        
        modified_count += 1
    
    # Save modified JMX
    try:
        tree.write(jmx_file, encoding='UTF-8', xml_declaration=True)
        print(f"{'='*70}")
        print(f"[SUCCESS] Successfully injected partitioning into {modified_count} CSV config(s)")
        print(f"{'='*70}\n")
    except Exception as e:
        print(f"[ERROR] Error writing JMX file: {e}")
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: python3 inject-jmx-partitioning.py <jmx_file> <container_id> <total_containers>")
        print("\nExample:")
        print("  python3 inject-jmx-partitioning.py /tmp/test.jmx 0 4")
        sys.exit(1)
    
    jmx_file = sys.argv[1]
    container_id = int(sys.argv[2])
    total_containers = int(sys.argv[3])
    
    if not os.path.exists(jmx_file):
        print(f"[ERROR] File not found: {jmx_file}")
        sys.exit(1)
    
    inject_partitioning(jmx_file, container_id, total_containers)